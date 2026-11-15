# Chapter 4 lab: two small programs.
#   pointers  addresses, dereferencing, pointer arithmetic, array decay, references, const and std::span
#   matmul    a row-major matrix, a naive matmul written with pointers, and strided views
#
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build
#   ./build/pointers
#   ./build/matmul
#
# Add -DLAB_SANITIZE=ON to build with AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang only).

cmake_minimum_required(VERSION 3.20)
project(cpp_pointers LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LAB_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(LAB_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

foreach(prog pointers matmul)
  add_executable(${prog} ${prog}.cpp)
  target_compile_options(${prog} PRIVATE -Wall -Wextra -Wpedantic)
endforeach()
