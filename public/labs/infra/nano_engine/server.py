# server.py: an OpenAI-compatible HTTP server for nano_engine, with streaming.
#
#   python -m nano_engine.server --model HuggingFaceTB/SmolLM2-135M-Instruct --port 8000
#   curl -N localhost:8000/v1/chat/completions -H 'Content-Type: application/json' \
#        -d '{"messages": [{"role": "user", "content": "Name three rivers."}], "max_tokens": 40, "stream": true}'
#
# The engine loop runs in its own thread and the HTTP server in the asyncio event loop of the main thread, as in
# vLLM, where they are separate processes. Requests reach the engine through a thread-safe queue; each request's
# tokens come back through its own asyncio queue. Streaming uses server-sent events: one "data: {json}" line per
# chunk, then "data: [DONE]". A client that disconnects is aborted, which frees its KV blocks.
import argparse
import asyncio
import json
import queue
import threading
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .engine import EngineConfig, LLMEngine
from .scheduler import SchedulerConfig
from .sequence import SamplingParams


class AsyncEngine:
    """Runs LLMEngine.step() in a background thread and routes each output to the request that owns it."""

    def __init__(self, engine: LLMEngine):
        self.engine = engine
        self.inbox: queue.Queue = queue.Queue()               # ("add", ...) or ("abort", request_id)
        self.streams: dict[str, tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = {}
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        try:
            self._serve()
        except Exception as e:                                # tell every waiting client, then stop
            for rid in list(self.streams):
                self._send(rid, ("error", f"engine failed: {e!r}"))
            raise

    def _serve(self) -> None:
        while True:
            # Block while idle; otherwise take whatever arrived since the last step without waiting.
            items = [self.inbox.get()] if not self.engine.has_work() else []
            while not self.inbox.empty():
                items.append(self.inbox.get_nowait())
            for kind, *args in items:
                if kind == "add":
                    try:
                        self.engine.add_request(*args)
                    except ValueError as e:
                        self._send(args[0], ("error", str(e)))
                else:
                    self.engine.abort(args[0])
                    self.streams.pop(args[0], None)
            finished = set()
            for out in self.engine.step():
                rid = out.seq.request_id
                self._send(rid, ("token", out.seq.index, out.new_token_ids, out.seq.finish_reason))
                if out.finished:
                    finished.add(rid)
            for rid in finished:              # done when all n completions are, after this step's last tokens
                if all(s.finish_reason for s in self.engine.requests.get(rid, [])):
                    self.engine.requests.pop(rid, None)
                    self._send(rid, ("done",))

    def _send(self, rid: str, item: tuple) -> None:
        if rid in self.streams:
            loop, q = self.streams[rid]
            loop.call_soon_threadsafe(q.put_nowait, item)

    async def generate(self, rid: str, prompt: list[int], params: SamplingParams):
        """Yields ("token", index, token_ids, finish_reason) items until the request is done."""
        q: asyncio.Queue = asyncio.Queue()
        self.streams[rid] = (asyncio.get_running_loop(), q)
        self.inbox.put(("add", rid, prompt, params))
        done = False
        try:
            while (item := await q.get())[0] != "done":
                if item[0] == "error":
                    raise ValueError(item[1])
                yield item
            done = True
        finally:
            self.streams.pop(rid, None)
            if not done:                                      # the client left early: free its blocks
                self.inbox.put(("abort", rid))


class Detokenizer:
    """Turns a growing list of token ids into text increments. Holds text back while it ends in an incomplete
    UTF-8 character, which a byte-level tokenizer produces when one character spans several tokens."""

    def __init__(self, tokenizer):
        self.tokenizer, self.ids, self.sent = tokenizer, [], 0

    def add(self, ids: list[int]) -> str:
        self.ids += ids
        text = self.tokenizer.decode(self.ids, skip_special_tokens=True)
        if text.endswith("�"):
            return ""
        new, self.sent = text[self.sent :], len(text)
        return new


def build_app(engine: LLMEngine, model_name: str) -> FastAPI:
    app = FastAPI()
    async_engine = AsyncEngine(engine)
    tok = engine.tokenizer

    def params_from(body: dict) -> SamplingParams:
        return SamplingParams(temperature=body.get("temperature", 1.0), top_p=body.get("top_p", 1.0),
                              max_tokens=body.get("max_tokens") or body.get("max_completion_tokens") or 256,
                              n=body.get("n", 1), ignore_eos=body.get("ignore_eos", False))

    async def complete(body: dict, prompt: list[int], chat: bool):
        rid = f"{'chatcmpl' if chat else 'cmpl'}-{uuid.uuid4().hex}"
        params = params_from(body)
        created = int(time.time())
        kind = "chat.completion" if chat else "text_completion"
        detok = [Detokenizer(tok) for _ in range(params.n)]
        n_out = 0

        def choice(i: int, text: str, finish: str | None, final: bool) -> dict:
            if chat:
                key = "message" if final else "delta"
                return {"index": i, key: {"role": "assistant", "content": text}, "finish_reason": finish}
            return {"index": i, "text": text, "finish_reason": finish}

        def usage() -> dict:
            return {"prompt_tokens": len(prompt), "completion_tokens": n_out, "total_tokens": len(prompt) + n_out}

        if not body.get("stream"):
            texts, finish = [""] * params.n, [None] * params.n
            try:
                async for _, i, ids, reason in async_engine.generate(rid, prompt, params):
                    n_out += len(ids)
                    texts[i] += detok[i].add(ids)
                    finish[i] = reason
            except ValueError as e:
                return JSONResponse({"error": {"message": str(e)}}, status_code=400)
            return {"id": rid, "object": kind, "created": created, "model": model_name,
                    "choices": [choice(i, texts[i], finish[i], True) for i in range(params.n)], "usage": usage()}

        async def events():
            nonlocal n_out
            chunk = {"id": rid, "object": f"{kind}.chunk" if chat else kind, "created": created, "model": model_name}
            try:
                async for _, i, ids, reason in async_engine.generate(rid, prompt, params):
                    n_out += len(ids)
                    yield f"data: {json.dumps({**chunk, 'choices': [choice(i, detok[i].add(ids), reason, False)]})}\n\n"
            except ValueError as e:
                yield f"data: {json.dumps({'error': {'message': str(e)}})}\n\n"
            if (body.get("stream_options") or {}).get("include_usage"):
                yield f"data: {json.dumps({**chunk, 'choices': [], 'usage': usage()})}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": model_name, "object": "model", "owned_by": "nano_engine"}]}

    @app.post("/v1/completions")
    async def completions(request: Request):
        body = await request.json()
        return await complete(body, tok.encode(body["prompt"]), chat=False)

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        body = await request.json()
        # The chat template turns the messages into one string with the model's role markers; it already holds any
        # special tokens the model expects, so encoding must not add them again.
        text = tok.apply_chat_template(body["messages"], add_generation_prompt=True, tokenize=False)
        return await complete(body, tok.encode(text, add_special_tokens=False), chat=True)

    return app


def main() -> None:
    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=EngineConfig.model)
    ap.add_argument("--device", default=EngineConfig.device)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--max-model-len", type=int, default=4096)
    ap.add_argument("--kv-cache-gib", type=float, default=1.0)
    ap.add_argument("--max-num-seqs", type=int, default=256)
    ap.add_argument("--max-num-batched-tokens", type=int, default=2048)
    a = ap.parse_args()
    engine = LLMEngine(EngineConfig(model=a.model, device=a.device, max_model_len=a.max_model_len,
                                    kv_cache_gib=a.kv_cache_gib,
                                    scheduler=SchedulerConfig(a.max_num_seqs, a.max_num_batched_tokens)))
    print(f"nano_engine: {a.model} on {a.device}, {engine.blocks.num_blocks} KV blocks of {engine.config.block_size} tokens")
    uvicorn.run(build_app(engine, a.model), host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
