# Chapter 3 lab: three small programs.
#   lifetime     prints when each object is constructed and destroyed
#   layout       sizeof, alignof, offsetof and padding
#   memory_demo  a stack overflow, a leak and a dangling pointer, one mode at a time
#
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
#   cmake --build build
#   ./build/lifetime
#   ./build/layout
#   ./build/memory_demo stack-big
#
# Add -DLAB_SANITIZE=ON to build with AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang only).

cmake_minimum_required(VERSION 3.20)
project(cpp_memory LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LAB_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(LAB_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

foreach(prog lifetime layout memory_demo)
  add_executable(${prog} ${prog}.cpp)
  target_compile_options(${prog} PRIVATE -Wall -Wextra -Wpedantic)
endforeach()
