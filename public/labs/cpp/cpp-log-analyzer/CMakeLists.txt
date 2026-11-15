# Project A: a log analyzer, in Python (analyze.py) and C++ (this project).
#
#   python3 gen_logs.py big.log                        # 5,000,000 lines
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build
#   ctest --test-dir build                             # the parser and percentile checks
#   ./build/log_analyzer big.log > report_cpp.txt
#
# Add -DLAB_SANITIZE=ON (with -DCMAKE_BUILD_TYPE=Debug and a separate build folder) to build with
# AddressSanitizer and UndefinedBehaviorSanitizer (GCC and Clang only).

cmake_minimum_required(VERSION 3.20)
project(log_analyzer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LAB_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
if(LAB_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()

# The parser and the statistics, as a library that both the program and the tests link.
add_library(loga_core src/log_parser.cpp src/stats.cpp)
target_include_directories(loga_core PUBLIC src)
target_compile_options(loga_core PRIVATE -Wall -Wextra -Wpedantic)

add_executable(log_analyzer src/main.cpp)
target_link_libraries(log_analyzer PRIVATE loga_core)
target_compile_options(log_analyzer PRIVATE -Wall -Wextra -Wpedantic)

add_executable(test_core tests/test_core.cpp)
target_link_libraries(test_core PRIVATE loga_core)
target_compile_options(test_core PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_test(NAME test_core COMMAND test_core)
