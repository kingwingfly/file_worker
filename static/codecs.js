'use strict';
/*
 * codecs.js — what *this device* can decode, and what to say when it can't.
 *
 * Shared by the gallery (`app.js`) and the clip page (`clip.js`), because both
 * have a player that can be handed a file no decoder on this machine
 * understands, and the answer must be the same on both. It used to live only in
 * `app.js`; the clip page had no error handling at all and showed a black box.
 *
 * Everything here runs **after** a playback failure. As a pre-flight gate it
 * would be wrong: files are served as `video/mp4` whatever is inside, so
 * `canPlayType` reports browser capability and says nothing about which codec
 * is in this particular file. See CLAUDE.md.
 *
 * Namespaced rather than declared at top level on purpose — classic scripts
 * share one global lexical scope, so a bare `const CODECS` here would collide
 * with anything a page script happens to name the same way and take the whole
 * page down with a SyntaxError.
 */
(function (global) {
  // Codecs an admin might upload, with the advice that applies when this
  // device turns out to lack a decoder for one. The HEVC and AV1 cases are
  // near-inverses: Chrome and Firefox ship a software AV1 decoder so AV1 plays
  // there on any platform, while HEVC needs an OS-provided hardware decoder
  // and is Safari's strong suit.
  var CODECS = [
    {
      name: 'H.264',
      type: 'video/mp4; codecs="avc1.42E01E"',
      advice: '若此文件为 H.264：几乎所有浏览器都支持，播放失败通常说明文件本身有问题。',
    },
    {
      name: 'HEVC (H.265)',
      type: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
      advice: '若此文件为 HEVC：请改用 Safari。Chrome 没有软件解码器，只能在 macOS、'
        + 'Android，以及装了「HEVC 视频扩展」的 Windows 上播放；Linux 版 Chrome 和 '
        + 'Firefox 无法播放。',
    },
    {
      // Probed at **10-bit** (`…M.10`), because that is what this gallery
      // serves — the AV1 encode is `-pix_fmt yuv420p10le` (see README). A
      // software decoder answers the same for both depths, so this changes
      // nothing on Chrome or Firefox; it matters on a device whose AV1 support
      // is hardware-only, where an 8-bit probe could claim support this
      // gallery's files would not actually get.
      name: 'AV1 (10-bit)',
      type: 'video/mp4; codecs="av01.0.05M.10"',
      advice: '若此文件为 AV1：请改用 Chrome 或 Firefox，两者都内置软件解码器，任何平台都可播放。'
        + 'Safari 需要 17 及以上版本，并且要 M3 代及以后的 Apple 芯片；M1、M2 无论系统版本都无法解码。',
    },
    {
      name: 'VP9',
      type: 'video/mp4; codecs="vp09.00.10.08"',
      advice: '若此文件为 VP9：请改用 Chrome 或 Firefox。',
    },
  ];

  // What this device can decode.
  function probe() {
    var el = document.createElement('video');
    return CODECS.map(function (codec) {
      return {
        name: codec.name,
        type: codec.type,
        advice: codec.advice,
        // '' means no; 'maybe' and 'probably' both mean it will try.
        supported: el.canPlayType(codec.type) !== '',
      };
    });
  }

  // The page-neutral half of the notice: heading, the support row, and the
  // advice that follows from it. Callers append their own actions — the
  // gallery offers a download, the clip page also offers another source — so
  // this returns an array of nodes rather than a finished box, and neither
  // page has to know how the other recovers.
  function buildPanel(heading) {
    var results = probe();
    var unsupported = results.filter(function (c) { return !c.supported; });

    var title = document.createElement('h3');
    title.textContent = heading || '⚠️ 此浏览器无法播放该视频';

    var intro = document.createElement('p');
    intro.textContent = '当前设备的视频解码能力：';

    var list = document.createElement('div');
    list.className = 'codec-support';
    results.forEach(function (codec) {
      var item = document.createElement('span');
      item.className = codec.supported ? 'ok' : 'no';
      item.textContent = (codec.supported ? '✅ ' : '❌ ') + codec.name;
      list.appendChild(item);
    });

    var advice = document.createElement('p');
    advice.textContent = unsupported.length
      ? unsupported.map(function (c) { return c.advice; }).join(' ')
      // Every codec probes as playable, so the container is the likelier
      // culprit — .mkv passes the server's video/* check but no browser plays
      // it. An audio-only proxy lands here too: Opus in MP4 has no row above
      // and does not play in Safari.
      : '此设备支持上述所有编码，问题可能出在容器格式（例如 .mkv）、音频编码（例如 MP4 里的 Opus）'
        + '或文件本身。请下载后用本地播放器打开。';

    return [title, intro, list, advice];
  }

  global.VideoCodecs = { CODECS: CODECS, probe: probe, buildPanel: buildPanel };
})(window);
