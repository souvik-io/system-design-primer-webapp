# Chapter 2 lab: two small programs.
#   traps   prints the chapter's "predict the output" snippets, numbered like the quiz
#   dtypes  a dtype table, symmetric int8 quantization and int4 packing
#
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
#   cmake --build build
#   ./build/traps
#   ./build/dtypes
#
# Add -DLAB_SANITIZE=ON to build with AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang only).
# UBSan then reports the signed overflow in traps.cpp while the program runs.

cmake_minimum_required(VERSION 3.20)
project(cpp_syntax LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LAB_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(LAB_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

foreach(prog traps dtypes)
  add_executable(${prog} ${prog}.cpp)
  target_compile_options(${prog} PRIVATE -Wall -Wextra -Wpedantic)
endforeach()
