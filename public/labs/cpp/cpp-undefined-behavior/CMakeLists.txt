# Chapter 5 lab: undefined behavior and the tools that catch it.
#   ub_zoo     eight bugs, one per mode
#   optimizer  code whose answer changes between Debug and Release because it relies on signed overflow
#
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
#   cmake --build build
#   ./build/ub_zoo row-means
#   ./build/optimizer 2147483647
#
# Options:
#   -DLAB_SANITIZE=ON   build with AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang)
#   -DLAB_HARDEN=ON     turn on the standard library's own checks, so that std::vector::operator[] checks its index
#                       (_GLIBCXX_ASSERTIONS for GCC's libstdc++, _LIBCPP_HARDENING_MODE for LLVM's libc++)

cmake_minimum_required(VERSION 3.20)
project(cpp_undefined_behavior LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LAB_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(LAB_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

option(LAB_HARDEN "Turn on the standard library's precondition checks" OFF)
if(LAB_HARDEN)
  add_compile_definitions(_GLIBCXX_ASSERTIONS _LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST)
endif()

foreach(prog ub_zoo optimizer)
  add_executable(${prog} ${prog}.cpp)
  target_compile_options(${prog} PRIVATE -Wall -Wextra -Wpedantic)
endforeach()
