#!/bin/bash
# 最小化 FFmpeg WASM 构建（解码 + 随机定位）
#
# 依赖（一次性准备，装在仓库外，脚本会自动克隆）：
#   ~/Developer/emsdk            —— emscripten 官方独立工具链
#   ~/Developer/ffmpeg-wasm-src  —— ffmpeg 源码（默认 pin n7.1.1）
#
# 解码范围：wma(wmav1/v2) + mp3 + flac(16/24-bit) + wav(pcm 16/24/32/float) + aac/m4a
# （ogg/ape 暂未开；要加就往两个 enable 列表里补名字，每个约百 KB 级）
#
# 产物：miniprogram/wasm/ffdecode.wasm.br（自动 brotli 压缩）
set -e
cd "$(dirname "$0")/../../"   # 项目根

EMSDK="$HOME/Developer/emsdk"
FFSRC="$HOME/Developer/ffmpeg-wasm-src"
FFTAG="${FFMPEG_TAG:-n7.1.1}"

if [ ! -f "$EMSDK/emsdk_env.sh" ]; then
  echo "== 0/3 安装 emsdk（首次较慢）=="
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK"
  "$EMSDK/emsdk" install latest
  "$EMSDK/emsdk" activate latest
fi
if [ ! -d "$FFSRC" ]; then
  echo "== 0/3 克隆 FFmpeg $FFTAG =="
  git clone --depth 1 --branch "$FFTAG" https://github.com/FFmpeg/FFmpeg.git "$FFSRC"
fi

if command -v emcc >/dev/null 2>&1; then
  echo "== 使用系统 emcc（Homebrew emscripten）=="
elif [ -f "$EMSDK/emsdk_env.sh" ]; then
  source "$EMSDK/emsdk_env.sh" >/dev/null
else
  echo "缺少 emcc：请安装 emscripten 或恢复 ~/Developer/emsdk" >&2
  exit 1
fi

echo "== 1/3 configure ffmpeg（容器 + 解码器最小集）=="
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
  --enable-decoder=wmav1,wmav2,mp3float,flac,aac,pcm_s16le,pcm_f32le,pcm_s24le,pcm_s32le \
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
  -s INITIAL_MEMORY=24MB \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_ff_open","_ff_pull","_ff_close","_ff_seek","_ff_tell","_ff_rate","_ff_channels","_ff_err","_ff_duration_sec"]' \
  -o /tmp/ffdecode.wasm

echo "== 3/3 brotli 压缩 =="
node -e "
const fs = require('fs'), zlib = require('zlib')
const raw = fs.readFileSync('/tmp/ffdecode.wasm')
fs.writeFileSync('miniprogram/wasm/ffdecode.wasm.br',
  zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }))
console.log('原始', (raw.length/1048576).toFixed(2) + 'MB → 压缩', (fs.statSync('miniprogram/wasm/ffdecode.wasm.br').size/1048576).toFixed(2) + 'MB')
"
