import { fail } from './validation.js';
// 校验 JPEG 容器与 SOF 尺寸；不推断图像真实性，也不执行上传的任何数据。
export function jpegDimensions(data) {
  if (data.length < 16 || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) fail('invalid_jpeg', 415);
  let offset = 2, size = null;
  while (offset < data.length - 2) {
    if (data[offset++] !== 0xff) fail('invalid_jpeg', 415);
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (offset + 2 > data.length) fail('invalid_jpeg', 415);
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length - 2) fail('invalid_jpeg', 415);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) fail('invalid_jpeg', 415);
      size = { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      if (size.width < 1 || size.height < 1 || size.width > 2560 || size.height > 1920 || size.width * size.height > 4_915_200) fail('jpeg_dimensions_out_of_range', 413);
    }
    if (marker === 0xda) { if (!size) fail('jpeg_sof_missing', 415); return size; }
    offset += length;
  }
  fail('jpeg_scan_missing', 415);
}
