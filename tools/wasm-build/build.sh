#!/bin/bash
# 最小化 FFmpeg WASM 构建（wma 解码专用）
#
# 依赖（一次性准备，均已装在仓库外）：
#   ~/Developer/emsdk        —— emscripten 官方独立工具链（不污染 brew 环境）
#   ~/Developer/ffmpeg-wasm-src —— ffmpeg 浅克隆源码
#
# 解码范围：wma(wmav1/v2) + mp3 + flac + wav(pcm) + aac/m4a
# （ogg/ape 暂未开；要加就往两个 enable 列表里补名字，每个约百 KB 级）
#
# 产物：miniprogram/wasm/ffdecode.wasm.br（自动 brotli 压缩）
set -e
cd "$(dirname "$0")/../../"   # 项目根

source "$HOME/Developer/emsdk/emsdk_env.sh" >/dev/null
FFSRC="$HOME/Developer/ffmpeg-wasm-src"

echo "== 1/3 configure ffmpeg（只留 asf 容器 + wmav1/wmav2 解码器）=="
cd "$FFSRC"
emconfigure ./configure \
  --arch=wasm --target-os=none \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib \
  --disable-everything --disable-programs --disable-doc --disable-avdevice \
  --disable-swresample --disable-swscale --disable-network \
  --disable-autodetect --disable-iconv --disable-zlib --disable-bzlib --disable-lzma \
  --disable-sdl2 --disable-vaapi --disable-vdpau --disable-cuda --disable-cuda-llvm \
  --disable-vulkan --disable-d3d11va --disable-dxva2 --disable-asm \
  --enable-avcodec --enable-avformat --enable-avutil \
  --enable-decoder=wmav1,wmav2,mp3float,flac,aac,pcm_s16le,pcm_f32le \
  --enable-demuxer=asf,mp3,flac,wav,aac,mov \
  --enable-small \
  --extra-cflags="-Os -fno-exceptions -fno-unwind-tables"

echo "== 2/3 编译静态库 + 链接 wasm =="
emmake make -j"$(sysctl -n hw.ncpu)" >/dev/null

cd - >/dev/null
mkdir -p miniprogram/wasm
emcc tools/wasm-build/ffdecode.c \
  -I"$FFSRC" \
  "$FFSRC/libavcodec/libavcodec.a" \
  "$FFSRC/libavformat/libavformat.a" \
  "$FFSRC/libavutil/libavutil.a" \
  -Oz --no-entry -s STANDALONE_WASM -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16MB \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_ff_open","_ff_pull","_ff_close","_ff_rate","_ff_channels","_ff_err","_ff_duration_sec"]' \
  -o /tmp/ffdecode.wasm

echo "== 3/3 brotli 压缩 =="
node -e "
const fs = require('fs'), zlib = require('zlib')
const raw = fs.readFileSync('/tmp/ffdecode.wasm')
fs.writeFileSync('miniprogram/wasm/ffdecode.wasm.br',
  zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }))
console.log('原始', (raw.length/1048576).toFixed(2) + 'MB → 压缩', (fs.statSync('miniprogram/wasm/ffdecode.wasm.br').size/1048576).toFixed(2) + 'MB')
"
