# Chapter 7 lab: copy and move semantics.
#   moves  counts the copies, moves and allocations behind ordinary-looking code, one mode at a time
#
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build
#   ./build/moves copy-loop
#
# Options:
#   -DLAB_SANITIZE=ON   build with AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang)
#   -DLAB_NO_ELIDE=ON   pass -fno-elide-constructors, which turns off the optional copy elisions such as NRVO
#                       (the elisions C++17 guarantees cannot be turned off)

cmake_minimum_required(VERSION 3.20)
project(cpp_copy_move LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LAB_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(LAB_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

option(LAB_NO_ELIDE "Turn off optional copy elision (NRVO)" OFF)
if(LAB_NO_ELIDE)
  add_compile_options(-fno-elide-constructors)
endif()

add_executable(moves moves.cpp)
# -Wpessimizing-move and -Wredundant-move flag a std::move that blocks or duplicates the compiler's own work.
# GCC 9 and newer and every recent Clang know both names; they are listed here so that neither depends on -Wall or -Wextra.
target_compile_options(moves PRIVATE -Wall -Wextra -Wpedantic -Wpessimizing-move -Wredundant-move)
