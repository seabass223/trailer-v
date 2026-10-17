export const QUAD_WGSL = /* wgsl */ `
struct U {
  rect: vec4f,    // NDC: left, top, right, bottom
  color: vec4f,   // straight RGBA (solid fills)
  params: vec4f,  // x: opacity, yz: uv size of one output pixel (0 = single tap)
};
@group(1) @binding(0) var<uniform> u: U;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let right = (i & 1u) == 1u;
  let bottom = (i & 2u) == 2u;
  var o: VO;
  o.pos = vec4f(select(u.rect.x, u.rect.z, right), select(u.rect.y, u.rect.w, bottom), 0.0, 1.0);
  o.uv = vec2f(select(0.0, 1.0, right), select(0.0, 1.0, bottom));
  return o;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var vid: texture_external;

@fragment fn fsExt(v: VO) -> @location(0) vec4f {
  var c: vec3f;
  let d = u.params.yz;
  if (d.x > 0.0) {
    // Rotated-grid 4-tap supersample: avoids shimmer when a 4K source is shown small.
    c = (textureSampleBaseClampToEdge(vid, samp, v.uv + d * vec2f(-0.125, -0.375)).rgb +
         textureSampleBaseClampToEdge(vid, samp, v.uv + d * vec2f( 0.375, -0.125)).rgb +
         textureSampleBaseClampToEdge(vid, samp, v.uv + d * vec2f( 0.125,  0.375)).rgb +
         textureSampleBaseClampToEdge(vid, samp, v.uv + d * vec2f(-0.375,  0.125)).rgb) * 0.25;
  } else {
    c = textureSampleBaseClampToEdge(vid, samp, v.uv).rgb;
  }
  let a = u.params.x;
  return vec4f(c * a, a);
}
`

export const TEX_WGSL = /* wgsl */ `
struct U { rect: vec4f, color: vec4f, params: vec4f };
@group(1) @binding(0) var<uniform> u: U;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let right = (i & 1u) == 1u;
  let bottom = (i & 2u) == 2u;
  var o: VO;
  o.pos = vec4f(select(u.rect.x, u.rect.z, right), select(u.rect.y, u.rect.w, bottom), 0.0, 1.0);
  o.uv = vec2f(select(0.0, 1.0, right), select(0.0, 1.0, bottom));
  return o;
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var img: texture_2d<f32>;

// Textures hold premultiplied alpha.
@fragment fn fsTex(v: VO) -> @location(0) vec4f {
  return textureSample(img, samp, v.uv) * u.params.x;
}

@fragment fn fsSolid(v: VO) -> @location(0) vec4f {
  let a = u.color.a * u.params.x;
  return vec4f(u.color.rgb * a, a);
}
`

/** RGBA -> NV12 (BT.709, limited range). Y plane then interleaved UV, packed 4 bytes per u32. */
export const NV12_WGSL = (w: number, h: number) => /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outb: array<u32>;

const W = ${w}u;
const H = ${h}u;

fn luma(c: vec3f) -> u32 {
  return u32(clamp(16.0 + 219.0 * dot(c, vec3f(0.2126, 0.7152, 0.0722)) + 0.5, 0.0, 255.0));
}
fn cb(c: vec3f) -> u32 {
  return u32(clamp(128.0 + 224.0 * dot(c, vec3f(-0.114572, -0.385428, 0.5)) + 0.5, 0.0, 255.0));
}
fn cr(c: vec3f) -> u32 {
  return u32(clamp(128.0 + 224.0 * dot(c, vec3f(0.5, -0.454153, -0.045847)) + 0.5, 0.0, 255.0));
}
fn avg2x2(x: u32, y: u32) -> vec3f {
  return (textureLoad(src, vec2u(x, y), 0).rgb + textureLoad(src, vec2u(x + 1u, y), 0).rgb +
          textureLoad(src, vec2u(x, y + 1u), 0).rgb + textureLoad(src, vec2u(x + 1u, y + 1u), 0).rgb) * 0.25;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  let yWords = W * H / 4u;
  let uvWords = (H / 2u) * (W / 4u);
  if (n < yWords) {
    let y = n / (W / 4u);
    let x = (n % (W / 4u)) * 4u;
    var word = 0u;
    for (var i = 0u; i < 4u; i++) {
      word |= luma(textureLoad(src, vec2u(x + i, y), 0).rgb) << (8u * i);
    }
    outb[n] = word;
  } else if (n < yWords + uvWords) {
    let k = n - yWords;
    let cy = k / (W / 4u);
    let cx = (k % (W / 4u)) * 2u;
    let a = avg2x2(cx * 2u, cy * 2u);
    let b = avg2x2(cx * 2u + 2u, cy * 2u);
    outb[n] = cb(a) | (cr(a) << 8u) | (cb(b) << 16u) | (cr(b) << 24u);
  }
}
`
