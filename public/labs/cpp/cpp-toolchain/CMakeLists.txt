# Chapter 1 lab: tinymath, a tiny vector-math library and a program that uses it.
#
#   cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release
#   cmake --build build-release
#   ./build-release/demo
#
# Add -DTINYMATH_SANITIZE=ON to build with AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang only).

cmake_minimum_required(VERSION 3.20)
project(tinymath LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)           # -std=c++20, not -std=gnu++20
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)   # writes compile_commands.json for clangd and other editors

option(TINYMATH_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(TINYMATH_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

# The library: one source file, and a public include directory that anything linking it can see.
add_library(tinymath src/vec.cpp)
target_include_directories(tinymath PUBLIC include)
target_compile_options(tinymath PRIVATE -Wall -Wextra -Wpedantic)

# The program: links the library, and gets its include directory through PUBLIC above.
add_executable(demo src/main.cpp)
target_link_libraries(demo PRIVATE tinymath)
target_compile_options(demo PRIVATE -Wall -Wextra -Wpedantic)
