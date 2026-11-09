// Quaver — 远端缩略图的档位换算（零依赖纯函数，Node 可直接 strip-types 单测）
//
// 上游（QQ 音乐）给的 picurl/bigpic_url/avatar 常是 500/600 档，侧栏歌单封面只画 32px、
// 头像只画 44px。浏览器会按原图解码成位图常驻内存：一张 600×600 RGBA ≈ 1.4MB，
// 三四十个歌单就是几十 MB —— 与「总内存偏高」的主要来源之一吻合。
//
// 这里只改 URL 里的尺寸档，不碰域名/路径/查询串。认不出的图床原样返回（宁可多花内存，
// 也不猜一个可能 404 的地址）。已知三种上游形态（实测 90 档全部 200）：
//   y.gtimg.cn/music/photo_new/T002R500x500M000….jpg
//   p.qpic.cn|qpic.y.qq.com/music_cover/<key>/600
//   music-file.y.qq.com/songlist/….jpg?imageView2/4/w/600/h/600

/** 把小图标用的远端图降到实际需要的档位（默认 90，够 2× DPR 的 44px 头像）。 */
export function thumbPic(u: string | undefined, size = 90): string {
  const px = String(size);

  return (u ?? "").replace(/^http:/, "https:")
    .replace(/(T\d+R)\d+x\d+(M)/, `$1${px}x${px}$2`)
    .replace(/(\/music_cover\/[^/?#]+\/)\d+(?=[?#]|$)/, `$1${px}`)
    .replace(/(imageView2\/\d+\/w\/)\d+(\/h\/)\d+/, `$1${px}$2${px}`);
}
