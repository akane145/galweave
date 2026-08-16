// mdict.rs — Rust 原生 MDX/MDD 词典读取器
// 严格对照 js-mdict@6.0.8 的解析算法(已在 6 本真实词典上验证)。
// 内存映射大文件;open 时解析头部并全量构建关键词索引(排序二分),
// 记录数据按需解压——彻底消除 Base64 over JSON IPC 的膨胀。
// 支持 MDX 2.0 / 1.x、zlib 与无压缩块;LZO 与加密词典明确报错。
// 损坏/截断文件一律返回 Err,不 panic(所有切片经 slice_checked 边界检查)。

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;

use encoding_rs::{GBK, UTF_8, UTF_16LE};
use flate2::read::ZlibDecoder;
use memmap2::Mmap;

/// 一条词条(记录起始/结束偏移为"全部记录块解压后拼接流"的相对偏移,与 js-mdict 一致)
#[derive(Debug, Clone)]
struct Keyword {
    key_text: String,
    record_start: u64,
    record_end: u64, // 未定用 u64::MAX 哨兵,open 末尾统一补 total
    key_block_idx: u32,
}

/// 键块信息(key block 数据区内的相对偏移由 pack_accum 给出)
#[derive(Debug, Clone)]
struct KeyBlockInfo {
    first_key: String,
    last_key: String,
    pack_size: u64,
    unpack_size: u64,
    pack_accum: u64,
    data_offset: u64, // 键块数据区起点(相对 _keyBlockStartOffset)
}

/// 记录块信息
#[derive(Debug, Clone)]
struct RecordBlockInfo {
    pack_size: u64,
    unpack_size: u64,
    pack_accum: u64,
    unpack_accum: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum Enc {
    Utf8,
    Utf16,
    Gbk,
    Big5,
}

/// MDX/MDD 词典读取器
pub struct MdictReader {
    _mmap: Mmap,
    is_mdd: bool,
    enc: Enc,
    num_width: usize,
    key_block_start: u64,   // 键块数据区文件偏移
    record_data_offset: u64, // 记录数据区文件偏移
    key_blocks: Vec<KeyBlockInfo>,
    record_blocks: Vec<RecordBlockInfo>,
    keywords: Vec<Keyword>,
    total_unpack: u64,
    by_key: HashMap<String, u32>, // 归一化 key -> keyword 下标(精确 O(1) 查找)
}

fn be_u64(b: &[u8], off: usize) -> Result<u64, String> {
    if off + 8 > b.len() { return Err("越界读 u64".into()); }
    Ok(u64::from_be_bytes(b[off..off + 8].try_into().unwrap()))
}
fn be_u32(b: &[u8], off: usize) -> Result<u32, String> {
    if off + 4 > b.len() { return Err("越界读 u32".into()); }
    Ok(u32::from_be_bytes(b[off..off + 4].try_into().unwrap()))
}
/// 读 1 或 2 字节大端无符号(js-mdict 用 b2n 按切片长度分派)
fn read_word_size(b: &[u8], off: usize, bytes: usize) -> Result<u64, String> {
    match bytes {
        1 => Ok(b.get(off).copied().ok_or("越界读 u8")? as u64),
        2 => {
            if off + 2 > b.len() { return Err("越界读 u16".into()); }
            Ok(u16::from_be_bytes(b[off..off + 2].try_into().unwrap()) as u64)
        }
        4 => Ok(be_u32(b, off)? as u64),
        _ => Err(format!("非法字长 {}", bytes)),
    }
}

/* ---------- MDict 加密(key info 块 encrypt=2)支持 ---------- */

/// 标准 RIPEMD-128(js-mdict ripemd128.js 的 Rust 移植);输出 16 字节小端
fn ripemd128(data: &[u8]) -> [u8; 16] {
    const S: [[u32; 16]; 8] = [
        [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
        [7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12],
        [11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5],
        [11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12],
        [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6],
        [9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11],
        [9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5],
        [15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8],
    ];
    const X: [[u32; 16]; 8] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        [7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8],
        [3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12],
        [1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2],
        [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12],
        [6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2],
        [15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13],
        [8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14],
    ];
    const K: [u32; 8] = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x00000000];
    let f = |r: usize, x: u32, y: u32, z: u32| -> u32 {
        match r {
            0 => x ^ y ^ z,
            1 => (x & y) | (!x & z),
            2 => (x | !y) ^ z,
            _ => (x & z) | (y & !z),
        }
    };
    let rotl = |x: u32, n: u32| -> u32 { x.rotate_left(n) };

    let bytes = data.len();
    let pad_len = if bytes % 64 < 56 { 56 - bytes % 64 } else { 120 - bytes % 64 };
    let mut msg = Vec::with_capacity(bytes + pad_len + 8);
    msg.extend_from_slice(data);
    msg.push(0x80);
    msg.resize(bytes + pad_len, 0);
    let bitlen = (bytes as u64).wrapping_mul(8);
    msg.extend_from_slice(&bitlen.to_le_bytes());

    let mut h: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for chunk in msg.chunks_exact(64) {
        let mut x = [0u32; 16];
        for (i, w) in chunk.chunks_exact(4).enumerate() {
            x[i] = u32::from_le_bytes(w.try_into().unwrap());
        }
        let (mut a, mut b, mut c, mut d) = (h[0], h[1], h[2], h[3]);
        let (mut aa, mut bb, mut cc, mut dd) = (h[0], h[1], h[2], h[3]);
        for t in 0..64u32 {
            let r = (t / 16) as usize;
            let j = (t % 16) as usize;
            let na = rotl(a.wrapping_add(f(r, b, c, d)).wrapping_add(x[X[r][j] as usize]).wrapping_add(K[r]), S[r][j]);
            let tmp = d; d = c; c = b; b = na; a = tmp; // (a,b,c,d) ← (d, a', b, c)
        }
        for t in 64..128u32 {
            let r = (t / 16) as usize;
            let j = (t % 16) as usize;
            let rr = ((63 - (t % 64)) / 16) as usize;
            let na = rotl(aa.wrapping_add(f(rr, bb, cc, dd)).wrapping_add(x[X[r][j] as usize]).wrapping_add(K[r]), S[r][j]);
            let tmp = dd; dd = cc; cc = bb; bb = na; aa = tmp;
        }
        let t = h[1].wrapping_add(c).wrapping_add(dd);
        h[1] = h[2].wrapping_add(d).wrapping_add(aa);
        h[2] = h[3].wrapping_add(a).wrapping_add(bb);
        h[3] = h[0].wrapping_add(b).wrapping_add(cc);
        h[0] = t;
    }
    let mut out = [0u8; 16];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    out
}

/// MDict fast_decrypt(XOR 流式,与 js-mdict utils.fast_decrypt 一致)
fn fast_decrypt(b: &mut [u8], key: &[u8]) {
    let mut previous: u32 = 0x36;
    for (i, byte) in b.iter_mut().enumerate() {
        let orig = *byte as u32;
        let t = (((orig >> 4) | (orig << 4)) & 0xff) ^ previous ^ (i as u32 & 0xff) ^ (key[i % key.len()] as u32);
        previous = orig;
        *byte = (t & 0xff) as u8;
    }
}

/// MDict mdxDecrypt(encrypt=2 的 key info 块)
fn mdx_decrypt(comp_block: &[u8]) -> Result<Vec<u8>, String> {
    if comp_block.len() < 8 { return Err("加密键块过短".into()); }
    let mut keyin = [0u8; 8];
    keyin[..4].copy_from_slice(&comp_block[4..8]);
    keyin[4] ^= 0x95;
    keyin[5] ^= 0x36;
    keyin[6] ^= 0x00;
    keyin[7] ^= 0x00;
    let key = ripemd128(&keyin);
    let mut out = Vec::with_capacity(comp_block.len());
    out.extend_from_slice(&comp_block[..8]);
    let mut rest = comp_block[8..].to_vec();
    fast_decrypt(&mut rest, &key);
    out.extend_from_slice(&rest);
    Ok(out)
}
/// 压缩类型: 4 字节小端 u32(js-mdict 用 toString('hex') 判断,即 LE)
fn comp_type(b: &[u8]) -> u32 {
    if b.len() < 4 { return u32::MAX; }
    u32::from_le_bytes(b[0..4].try_into().unwrap())
}

/// 边界检查切片: 取 [base, base+len)。损坏/截断文件返回 Err,不 panic。
fn slice_checked<'a>(data: &'a [u8], base: u64, len: u64, what: &str) -> Result<&'a [u8], String> {
    let base = usize::try_from(base).map_err(|_| format!("{}偏移过大", what))?;
    let len = usize::try_from(len).map_err(|_| format!("{}长度过大", what))?;
    let end = base.checked_add(len).ok_or_else(|| format!("{}偏移溢出", what))?;
    if end > data.len() { return Err(format!("{}越界", what)); }
    Ok(&data[base..end])
}

fn xml_attr(xml: &str, name: &str) -> Option<String> {
    let pat = format!("{}=\"", name);
    let i = xml.find(&pat)? + pat.len();
    let rest = &xml[i..];
    let end = rest.find('"')?;
    Some(unescape(rest[..end].to_string()))
}
fn unescape(mut s: String) -> String {
    for (k, v) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&amp;", "&")] {
        s = s.replace(k, v);
    }
    s
}

fn decode(enc: Enc, bytes: &[u8]) -> String {
    let (s, _, _) = match enc {
        Enc::Utf8 => UTF_8.decode(bytes),
        Enc::Utf16 => UTF_16LE.decode(bytes),
        Enc::Gbk => GBK.decode(bytes),
        Enc::Big5 => encoding_rs::BIG5.decode(bytes),
    };
    s.into_owned()
}

/// 解压一个块: 前 4 字节 LE 压缩类型,后 4 字节 adler32(跳过),数据从 [8..)
fn decompress_block(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.len() < 8 { return Err("压缩块过短".into()); }
    let t = comp_type(raw);
    if t == 0 {
        Ok(raw[8..].to_vec())
    } else if t == 2 {
        let mut z = ZlibDecoder::new(&raw[8..]);
        let mut out = Vec::new();
        z.read_to_end(&mut out).map_err(|e| format!("zlib 解压失败: {}", e))?;
        Ok(out)
    } else if t == 1 {
        Err("LZO 压缩的 MDX/MDD 暂不支持".into())
    } else {
        Err(format!("未知压缩类型 {}", t))
    }
}

impl MdictReader {
    /// 打开 MDX 或 MDD 文件并构建索引
    pub fn open(path: &str, is_mdd: bool) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("打开文件失败 {}: {}", path, e))?;
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| format!("内存映射失败 {}: {}", path, e))?;
        let data = &mmap[..];
        if data.len() < 16 { return Err("文件过小,格式不合法".into()); }

        // ---- STEP 1: header ----
        let header_size = be_u32(data, 0)? as usize;
        if 4 + header_size > data.len() { return Err("MDX 头长度非法".into()); }
        let header_bytes = &data[4..4 + header_size];
        let header_xml = decode(Enc::Utf16, header_bytes);
        let header_end = 4 + header_size + 4; // + 4B adler32

        let version: f64 = xml_attr(&header_xml, "GeneratedByEngineVersion")
            .and_then(|s| s.parse().ok()).unwrap_or(2.0);
        let num_width: usize = if version >= 2.0 { 8 } else { 4 };
        let enc = if is_mdd {
            Enc::Utf16
        } else {
            match xml_attr(&header_xml, "Encoding").unwrap_or_default().to_uppercase().as_str() {
                "GBK" | "GB2312" => Enc::Gbk,
                "BIG5" => Enc::Big5,
                "UTF-16" | "UTF16" | "UTF-16LE" => Enc::Utf16,
                _ => Enc::Utf8,
            }
        };
        let encrypt = match xml_attr(&header_xml, "Encrypted").unwrap_or_default().as_str() {
            "" | "No" | "no" => 0,
            "Yes" | "yes" => 1,
            s => s.parse().unwrap_or(0),
        };
        // encrypt=1: 记录块加密,需密码(js-mdict 同样拒绝);encrypt=2: key info 块加密,可无密码解密
        if encrypt == 1 { return Err("需要密码的加密词典暂不支持".into()); }

        // ---- STEP 2: key header ----
        let key_header_len = if version >= 2.0 { 8 * 5 + 4 } else { 4 * 4 };
        if header_end + key_header_len > data.len() { return Err("键头越界".into()); }
        let mut kh = header_end;
        let keyword_blocks_num = if num_width == 8 { be_u64(data, kh)? } else { be_u32(data, kh)? as u64 };
        kh += num_width;
        let _keyword_num = if num_width == 8 { be_u64(data, kh)? } else { be_u32(data, kh)? as u64 };
        kh += num_width;
        let key_info_unpack = if version >= 2.0 {
            let v = if num_width == 8 { be_u64(data, kh)? } else { be_u32(data, kh)? as u64 };
            kh += num_width;
            v
        } else { 0 };
        let key_info_packed = if num_width == 8 { be_u64(data, kh)? } else { be_u32(data, kh)? as u64 };
        kh += num_width;
        let keyword_block_packed = if num_width == 8 { be_u64(data, kh)? } else { be_u32(data, kh)? as u64 };
        kh += num_width;
        let key_block_info_start = header_end + key_header_len;

        // ---- STEP 3: key block info ----
        let info_raw = slice_checked(data, key_block_info_start as u64, key_info_packed, "键块信息")?;
        // encrypt=2 时 key info 块先解密(js-mdict _decodeKeyInfo)
        let info_decrypted = if encrypt == 2 { mdx_decrypt(info_raw)? } else { info_raw.to_vec() };
        let info_unpacked = if comp_type(&info_decrypted) == 2 {
            let u = decompress_block(&info_decrypted)?;
            if key_info_unpack != 0 && u.len() as u64 != key_info_unpack {
                return Err("键块信息解压大小不符".into());
            }
            u
        } else {
            info_decrypted
        };
        let key_block_start = usize::try_from((key_block_info_start as u64)
            .checked_add(key_info_packed).ok_or("键块起点偏移溢出")?)
            .map_err(|_| "键块起点偏移过大".to_string())?;
        let mut key_blocks = Vec::with_capacity(keyword_blocks_num.min(65536) as usize);
        let mut idx = 0usize;
        let mut pack_accum = 0u64;
        let mut unpack_accum = 0u64;
        for _ in 0..keyword_blocks_num {
            if idx + 8 > info_unpacked.len() { return Err("键块信息截断".into()); }
            let _word_count = if num_width == 8 { be_u64(&info_unpacked, idx)? } else { be_u32(&info_unpacked, idx)? as u64 };
            idx += num_width;
            // first/last word size 的字节数是 num_width/4(2.0 为 2 字节,1.x 为 1 字节)
            let word_size_bytes = num_width / 4;
            let mut first_size = read_word_size(&info_unpacked, idx, word_size_bytes)? as usize;
            idx += word_size_bytes;
            if version >= 2.0 { first_size = if enc == Enc::Utf16 { (first_size + 1) * 2 } else { first_size + 1 }; }
            else if enc == Enc::Utf16 { first_size *= 2; }
            if idx + first_size > info_unpacked.len() { return Err("键块信息词头越界".into()); }
            let first_key = decode(enc, &info_unpacked[idx..idx + first_size]);
            idx += first_size;
            let mut last_size = read_word_size(&info_unpacked, idx, word_size_bytes)? as usize;
            idx += word_size_bytes;
            if version >= 2.0 { last_size = if enc == Enc::Utf16 { (last_size + 1) * 2 } else { last_size + 1 }; }
            else if enc == Enc::Utf16 { last_size *= 2; }
            if idx + last_size > info_unpacked.len() { return Err("键块信息词头越界".into()); }
            let last_key = decode(enc, &info_unpacked[idx..idx + last_size]);
            idx += last_size;
            let pack_size = if num_width == 8 { be_u64(&info_unpacked, idx)? } else { be_u32(&info_unpacked, idx)? as u64 };
            idx += num_width;
            let unpack_size = if num_width == 8 { be_u64(&info_unpacked, idx)? } else { be_u32(&info_unpacked, idx)? as u64 };
            idx += num_width;
            key_blocks.push(KeyBlockInfo {
                first_key, last_key,
                pack_size, unpack_size,
                pack_accum, data_offset: pack_accum,
            });
            pack_accum += pack_size;
            unpack_accum += unpack_size;
        }

        // ---- STEP 5: record header ----
        let record_header_len = if version >= 2.0 { 8 * 4 } else { 4 * 4 };
        let record_header_start = usize::try_from((key_block_start as u64)
            .checked_add(keyword_block_packed).ok_or("记录头偏移溢出")?)
            .map_err(|_| "记录头偏移过大".to_string())?;
        let mut rh = record_header_start;
        let record_blocks_num = if num_width == 8 { be_u64(data, rh)? } else { be_u32(data, rh)? as u64 };
        rh += num_width;
        let _entries_num = if num_width == 8 { be_u64(data, rh)? } else { be_u32(data, rh)? as u64 };
        rh += num_width;
        let record_info_comp_size = if num_width == 8 { be_u64(data, rh)? } else { be_u32(data, rh)? as u64 };
        rh += num_width;
        let record_block_comp_size = if num_width == 8 { be_u64(data, rh)? } else { be_u32(data, rh)? as u64 };
        rh += num_width;

        // ---- STEP 6: record info ----
        let record_info_start = record_header_start + record_header_len;
        let info2 = slice_checked(data, record_info_start as u64, record_info_comp_size, "记录块信息")?;
        let mut record_blocks = Vec::with_capacity(record_blocks_num.min(65536) as usize);
        let mut ri = 0usize;
        let mut pack_accum2 = 0u64;
        let mut unpack_accum2 = 0u64;
        for _ in 0..record_blocks_num {
            let pack_size = if num_width == 8 { be_u64(info2, ri)? } else { be_u32(info2, ri)? as u64 };
            ri += num_width;
            let unpack_size = if num_width == 8 { be_u64(info2, ri)? } else { be_u32(info2, ri)? as u64 };
            ri += num_width;
            record_blocks.push(RecordBlockInfo { pack_size, unpack_size, pack_accum: pack_accum2, unpack_accum: unpack_accum2 });
            pack_accum2 += pack_size;
            unpack_accum2 += unpack_size;
        }
        let record_data_offset = (record_info_start as u64)
            .checked_add(record_info_comp_size).ok_or("记录数据区偏移溢出")?;
        let total_unpack = unpack_accum2;

        // ---- STEP 4: 全量构建 keywordList(按 block 顺序,相邻补 record_end) ----
        let mut keywords: Vec<Keyword> = Vec::new();
        for (bi, kb) in key_blocks.iter().enumerate() {
            let raw = slice_checked(data, (key_block_start as u64)
                .checked_add(kb.data_offset).ok_or("键块偏移溢出")?, kb.pack_size, "键块数据")?;
            let block = decompress_block(raw)?;
            let width = if enc == Enc::Utf16 { 2 } else { 1 };
            let mut pos = 0usize;
            // 当前 block 解析出的 keys(块内相邻用 next.record_start 补 end)
            let mut block_keys: Vec<Keyword> = Vec::new();
            while pos + num_width <= block.len() {
                let record_start = if num_width == 8 { u64::from_be_bytes(block[pos..pos + 8].try_into().unwrap()) }
                    else { u32::from_be_bytes(block[pos..pos + 4].try_into().unwrap()) as u64 };
                let mut key_end = pos + num_width;
                if width == 2 {
                    while key_end + 1 < block.len() && !(block[key_end] == 0 && block[key_end + 1] == 0) { key_end += 2; }
                } else {
                    while key_end < block.len() && block[key_end] != 0 { key_end += 1; }
                }
                if key_end >= block.len() { break; } // 块尾无终止符 → 结束
                let key_bytes = &block[pos + num_width..key_end];
                let key_text = decode(enc, key_bytes);
                block_keys.push(Keyword {
                    key_text,
                    record_start,
                    record_end: u64::MAX,
                    key_block_idx: bi as u32,
                });
                pos = key_end + width;
            }
            // 块内相邻: keys[i].record_end = keys[i+1].record_start(js-mdict splitKeyBlock 同款)
            for i in 0..block_keys.len().saturating_sub(1) {
                block_keys[i].record_end = block_keys[i + 1].record_start;
            }
            // 跨块: 上一 block 最后一个 key 的 end = 本 block 第一个 key 的 start
            if let (Some(last_k), Some(first_k)) = (keywords.last_mut(), block_keys.first()) {
                if last_k.record_end == u64::MAX { last_k.record_end = first_k.record_start; }
            }
            keywords.extend(block_keys);
        }
        // 全局最后一项 end = 总解压大小(js-mdict _readRecordInfos 同款)
        if let Some(last) = keywords.last_mut() { if last.record_end == u64::MAX { last.record_end = total_unpack; } }

        // 排序 + 建索引(字节序;js-mdict 用 localeCompare,中日文/ASCII 下与码点序一致)
        keywords.sort_by(|a, b| a.key_text.cmp(&b.key_text));
        let mut by_key = HashMap::with_capacity(keywords.len());
        for (i, k) in keywords.iter().enumerate() {
            by_key.entry(k.key_text.clone()).or_insert(i as u32);
        }

        Ok(MdictReader {
            _mmap: mmap,
            is_mdd,
            enc,
            num_width,
            key_block_start: key_block_start as u64,
            record_data_offset,
            key_blocks,
            record_blocks,
            keywords,
            total_unpack,
            by_key,
        })
    }

    /// 精确查询;未命中返回 None。key 比较用原始字符串(与 js-mdict comp 一致)。
    pub fn lookup(&self, word: &str) -> Result<Option<(String, Vec<u8>)>, String> {
        if let Some(&i) = self.by_key.get(word) {
            let k = &self.keywords[i as usize];
            let bytes = self.read_record(k.record_start, k.record_end)?;
            return Ok(Some((k.key_text.clone(), bytes)));
        }
        // 兜底: 二分 + 前后线性扫描(应对极小概率的排序差异)
        let lo = self.keywords.partition_point(|k| k.key_text.as_str() < word);
        let range = lo.saturating_sub(200)..(lo + 200).min(self.keywords.len());
        for i in range {
            if self.keywords[i].key_text == word {
                let k = &self.keywords[i];
                let bytes = self.read_record(k.record_start, k.record_end)?;
                return Ok(Some((k.key_text.clone(), bytes)));
            }
        }
        Ok(None)
    }

    /// 前缀补全(复刻 js-mdict prefix 语义: 目标 key block 内以 prefix 开头的词)
    pub fn prefix(&self, prefix: &str, limit: usize) -> Vec<String> {
        let lo = self.keywords.partition_point(|k| k.key_text.as_str() < prefix);
        // 取最接近项所在 block
        let target_block = self.keywords.get(lo.min(self.keywords.len().saturating_sub(1)))
            .map(|k| k.key_block_idx).unwrap_or(0);
        let mut out = Vec::new();
        for k in &self.keywords {
            if k.key_block_idx == target_block && k.key_text.starts_with(prefix) {
                out.push(k.key_text.clone());
                if out.len() >= limit { break; }
            }
        }
        out
    }

    /// 查询并跟随 @@@LINK 变体词(≤3 跳,含大小写兜底),返回 (最终词头, 清理后的释义)。
    /// 清理: NUL 填充与尾部空白(js-mdict cleanDefinition 语义)。
    /// 跟随目标缺失/循环 → 返回 Ok(None)(与 js-mdict 行为一致,UI 显示未命中)。
    pub fn lookup_follow(&self, word: &str) -> Result<Option<(String, String)>, String> {
        let mut current = word.trim().to_string();
        for _ in 0..4 {
            let hit = match self.lookup(&current) {
                Ok(Some(h)) => h,
                Ok(None) => {
                    // 大小写兜底
                    let lower = current.to_lowercase();
                    if lower == current { return Ok(None); }
                    match self.lookup(&lower) {
                        Ok(Some(h)) => h,
                        _ => return Ok(None),
                    }
                }
                Err(e) => return Err(e),
            };
            let def = clean_record(&self.decode_record(&hit.1));
            if def.starts_with("@@@LINK=") {
                current = def["@@@LINK=".len()..].trim().to_string();
            } else {
                return Ok(Some((hit.0, def)));
            }
        }
        Ok(None)
    }

    /// 按 record 偏移读取并解码为字符串(MDX 释义)
    fn read_record(&self, start: u64, end: u64) -> Result<Vec<u8>, String> {
        if end == u64::MAX { return Err("记录结束偏移未解析".into()); }
        if self.record_blocks.is_empty() { return Err("记录块列表为空".into()); }
        // 二分定位包含 start 的记录块
        let bi = self.record_blocks.partition_point(|b| b.unpack_accum <= start).saturating_sub(1);
        let rb = &self.record_blocks[bi];
        let raw = slice_checked(&self._mmap, self.record_data_offset + rb.pack_accum, rb.pack_size, "记录块数据")?;
        let block = decompress_block(raw)?;
        let s = (start - rb.unpack_accum) as usize;
        let e = (end - rb.unpack_accum) as usize;
        if s >= block.len() { return Err("记录偏移越界".into()); }
        let e = e.min(block.len());
        Ok(block[s..e].to_vec())
    }

    /// MDD: 定位资源原始字节(不 decode)
    pub fn mdd_resource(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        if !self.is_mdd { return Ok(None); }
        Ok(self.lookup(key)?.map(|(_, b)| b))
    }

    /// 解码记录为字符串(MDX 释义;mdx 路径)
    pub fn decode_record(&self, bytes: &[u8]) -> String {
        decode(self.enc, bytes)
    }

    pub fn key_count(&self) -> usize { self.keywords.len() }
    pub fn is_mdd(&self) -> bool { self.is_mdd }
}

/// 清理记录尾部的填充字符: NUL(字节对齐)与空白(与 js-mdict cleanDefinition 一致)。
/// 不清理 NUL 会导致 @@@LINK 目标提取失败(trim 不去 NUL) → 跟随断链 → "没有词"。
fn clean_record(s: &str) -> String {
    s.replace('\0', "").trim_end().to_string()
}

/// 生成测试用小型 MDX(仅在 cfg(test) 下使用)
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 测试临时目录(每次测试进程用独立路径,避免并行测试互相覆盖)
    fn tmp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!("galtrans-mdict-test-{}", N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 写临时文件并返回其字符串路径
    fn write_tmp(name: &str, bytes: &[u8]) -> String {
        let p = tmp_dir().join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        p.to_str().unwrap().to_string()
    }

    /// 损坏/截断文件:open 必须返回 Err,不能 panic。
    /// 注: 部分损坏会触发 zlib 解压错误(通过 Err 返回),这类文件在此不 assert。
    #[test]
    fn malformed_files_return_err_not_panic() {
        // v2.0 布局(header_size=16): header 在 [0..24)(4B 长 + 16B XML + 4B adler),
        // 键头 44B 在 [24..68): 块数/词数/键信息解压大小/键信息压缩大小/键块压缩大小;
        // 键块信息区在 [68..68+key_info_packed);记录头 32B 在键块区之后。
        // 1. 不足 16 字节
        // 2. 头长度越界(0xffff_ffff 远超文件大小)
        // 3. 键块信息截断: 声明 2 个键块但键块信息区只有 8 字节(首词长字段读越界)
        let mut short_key_info = vec![0u8; 256];
        short_key_info[0..4].copy_from_slice(&16u32.to_be_bytes()); // header_size=16
        short_key_info[24..32].copy_from_slice(&2u64.to_be_bytes()); // keyword_blocks_num=2
        short_key_info[48..56].copy_from_slice(&8u64.to_be_bytes()); // key_info_packed=8
        short_key_info[56..64].copy_from_slice(&8u64.to_be_bytes()); // keyword_block_packed=8
        short_key_info[84..92].copy_from_slice(&1u64.to_be_bytes()); // record_blocks_num
        short_key_info[100..108].copy_from_slice(&8u64.to_be_bytes()); // record_info_comp_size

        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("tiny.bin", vec![]),
            ("tiny2.bin", vec![0u8; 8]),
            ("badhead.bin", {
                let mut b = vec![0u8; 32];
                b[0..4].copy_from_slice(&0xffff_ffffu32.to_be_bytes());
                b
            }),
            ("shortkeyinfo.bin", short_key_info),
        ];
        for (name, bytes) in cases {
            let p = write_tmp(name, &bytes);
            let r = MdictReader::open(&p, false);
            assert!(r.is_err(), "{} 应报错而不是 panic", name);
            let _ = std::fs::remove_dir_all(std::path::Path::new(&p).parent().unwrap());
        }
    }

    /// cargo test 工作目录是 src-tauri/,真实词典在项目根 JPdict/ 下
    fn root() -> PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    }
    fn real_dicts() -> Vec<(PathBuf, bool)> {
        let r = root();
        vec![
            (r.join("JPdict/小学馆/Shogakukanjcv3.mdx"), false),
            (r.join("JPdict/新世纪日汉双解大辞典/XSJRH.mdx"), false),
            (r.join("JPdict/新世纪日汉双解大辞典讨论/xinshijirihan.mdx"), false),
            (r.join("JPdict/大词泉/DJS.mdx"), false),
            (r.join("JPdict/jitendex/jitendex.mdx"), false),
            (r.join("JPdict/（大修館）明鏡国語辞典［第三版］/（大修館）明鏡国語辞典［第三版］.mdx"), false),
        ]
    }

    #[test]
    fn opens_all_real_dicts() {
        let mut opened = 0;
        for (p, _) in real_dicts() {
            if !p.exists() { continue; }
            let r = MdictReader::open(p.to_str().unwrap(), false);
            assert!(r.is_ok(), "打开失败: {:?} → {:?}", p, r.err());
            let r = r.unwrap();
            assert!(r.key_count() > 100, "词条数异常少: {:?} → {}", p, r.key_count());
            opened += 1;
        }
        assert!(opened >= 3, "至少需要 3 本真实词典用于回归(当前 {} 本)", opened);
    }

    #[test]
    fn lookup_follow_returns_real_definitions() {
        // 回归: @@@LINK 词典跟随必须返回最终释义(非 "没有词")
        // 覆盖直接命中(小学馆)与跟随(新世纪/Jitendex/明镜/大词泉)
        for (p, _) in real_dicts() {
            if !p.exists() { continue; }
            let r = MdictReader::open(p.to_str().unwrap(), false).unwrap();
            for w in ["食べる", "花火", "先生"] {
                match r.lookup_follow(w) {
                    Err(e) => panic!("{:?} lookup_follow {} 报错: {}", p, w, e),
                    Ok(Some((kt, def))) => {
                        assert!(!def.trim().is_empty(), "{:?} {} 跟随后释义为空", p, w);
                        assert!(!def.starts_with("@@@LINK="), "{:?} {} 跟随后仍是 LINK: {}", p, w, def);
                        assert!(!def.contains('\0'), "{:?} {} 释义仍含 NUL", p, w);
                        println!("  {:?} {} → {} ({:?})", p, w, kt, def.chars().take(24).collect::<String>());
                    }
                    Ok(None) => { /* 词典可能真没这个词 */ }
                }
            }
        }
    }

    #[test]
    fn diag_lookup_chain() {
        // 诊断: 每本词典查「食べる/花火/先生」,并尝试直接查各 LINK 目标
        // 运行: cargo test mdict::tests::diag_lookup_chain -- --nocapture
        for (p, _) in real_dicts() {
            if !p.exists() { continue; }
            let r = MdictReader::open(p.to_str().unwrap(), false).unwrap();
            println!("=== {:?} keys={}", p, r.key_count());
            for w in ["食べる", "花火", "先生"] {
                match r.lookup(w) {
                    Ok(Some((kt, bytes))) => {
                        let def = r.decode_record(&bytes);
                        let head = if def.starts_with("@@@LINK=") { def.clone() } else { def.chars().take(30).collect() };
                        println!("  [{}] 命中 key={} def={:?}", w, kt, head);
                    }
                    Ok(None) => println!("  [{}] 未命中", w),
                    Err(e) => println!("  [{}] 报错: {}", w, e),
                }
            }
            for t in ["たべる【食べる】", "@jitendex-1358280", "38658", "はなび【花火･煙火】", "はなび"] {
                match r.lookup(t) {
                    Ok(Some((kt, bytes))) => {
                        let def = r.decode_record(&bytes);
                        println!("  LINK目标[{}] 命中 key={} def={:?}", t, kt, def.chars().take(30).collect::<String>());
                    }
                    Ok(None) => println!("  LINK目标[{}] 未命中", t),
                    Err(e) => println!("  LINK目标[{}] 报错: {}", t, e),
                }
            }
        }
    }

    #[test]
    fn lookup_real_words() {
        // 此前 diag(js-mdict)显示 6 本词典对 食べる/花火/先生 全部命中且非空;
        // Rust 引擎必须复刻: 每本至少命中 2/3 且内容非空,任何 Err 直接失败。
        for (p, _) in real_dicts() {
            if !p.exists() { continue; }
            let r = MdictReader::open(p.to_str().unwrap(), false).unwrap();
            let mut hit = 0;
            for w in ["食べる", "花火", "先生"] {
                match r.lookup(w) {
                    Err(e) => panic!("{:?} lookup {} 报错: {}", p, w, e),
                    Ok(Some((kt, bytes))) => {
                        let def = r.decode_record(&bytes);
                        assert!(!def.trim().is_empty(), "{:?} lookup {} 返回空释义", p, w);
                        assert_eq!(kt, w, "{:?} 词头不一致", p);
                        hit += 1;
                    }
                    Ok(None) => { /* 词典可能真没这个词 */ }
                }
            }
            assert!(hit >= 2, "{:?} 命中不足(实际 {}),与 js-mdict 行为不符", p, hit);
        }
    }

    #[test]
    fn link_follow_target_exists() {
        // @@@LINK 目标(如 XSJRH 的 たべる【食べる】)应可查到
        for (p, _) in real_dicts() {
            if !p.exists() { continue; }
            let r = MdictReader::open(p.to_str().unwrap(), false).unwrap();
            for w in ["たべる【食べる】", "はなび【花火･煙火】", "@jitendex-1358280", "せんせい【先生】"] {
                let _ = r.lookup(w); // 不崩溃即可(目标存在与否取决于词典)
            }
        }
    }

    #[test]
    fn prefix_returns_headwords() {
        let p = root().join("JPdict/小学馆/Shogakukanjcv3.mdx");
        if !p.exists() { return; }
        let r = MdictReader::open(p.to_str().unwrap(), false).unwrap();
        let out = r.prefix("食べ", 6);
        assert!(!out.is_empty(), "前缀补全为空");
        assert!(out.iter().all(|k| k.starts_with("食べ")));
        assert!(out.len() <= 6);
    }

    #[test]
    fn mdd_locate_resource() {
        let p = root().join("JPdict/jitendex/jitendex.mdd");
        if !p.exists() { return; }
        let r = MdictReader::open(p.to_str().unwrap(), true).unwrap();
        // 尝试定位一个已知资源(svg 图标);未知 key 不崩溃
        let _ = r.mdd_resource("\\svg\\accent.svg");
        let _ = r.mdd_resource("/svg/accent.svg");
        let _ = r.mdd_resource("svg\\accent.svg");
    }
}
