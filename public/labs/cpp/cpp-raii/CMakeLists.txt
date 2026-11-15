# Chapter 6 lab: classes and RAII.
#   raii_demo   file handles with and without RAII, stack unwinding, std::exit, ScopedTimer and the Matrix class
#   mistakes    four mistakes the compiler catches, built only when you ask for one with -DLAB_MISTAKE=N
#
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build
#   ./build/raii_demo unwind
#
# Options:
#   -DLAB_SANITIZE=ON   build with AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang)
#   -DLAB_MISTAKE=N     also build mistakes.cpp with mistake N (1 to 4); 1 to 3 fail to compile on purpose

cmake_minimum_required(VERSION 3.20)
project(cpp_raii LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LAB_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(LAB_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

add_executable(raii_demo raii_demo.cpp)
target_compile_options(raii_demo PRIVATE -Wall -Wextra -Wpedantic)

set(LAB_MISTAKE "" CACHE STRING "Build mistakes.cpp with this mistake number (1 to 4)")
if(LAB_MISTAKE)
  add_executable(mistakes mistakes.cpp)
  target_compile_definitions(mistakes PRIVATE MISTAKE=${LAB_MISTAKE})
  target_compile_options(mistakes PRIVATE -Wall -Wextra -Wpedantic)
endif()
