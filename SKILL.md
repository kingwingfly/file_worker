---
name: clip-description
description: Turns a recording into a list of named, timestamped clips with written descriptions, as YAML that imports directly into the zcll gallery's clipping page. Use when someone supplies a subtitle file, transcript, or other related file from a video and asks for 切片 / clips / highlights / a 归档, or asks to rewrite, merge, split, or re-describe an existing clip list.
---

# Writing clip descriptions

A **clip** is a time range into one recording, with a name and a description.
People browse a long list of them without watching anything, so the writing —
not the timestamps — is what makes a clip worth publishing.

Output YAML. The clipping page imports it verbatim; nothing else in this task
produces a deliverable.

## Inputs

Ask for whichever of these is missing before writing anything:

| Input | Where it comes from | Without it |
|---|---|---|
| A subtitle or transcript | 切片页 → 🤖 AI 辅助 → 📎 关联文件 | You cannot produce timestamps. Say so. |
| What the recording is | The user | Names will be generic. |
| How many clips, or how long | The user | Default to 5–15 clips of 30–300s. |

**Every timestamp must be traceable to a line in the source.** Subtitle cues
carry `00:01:23,456 --> 00:01:31,000`; convert to seconds (`83.456`). If the
user gives times verbally, use them and say plainly that they are unverified.
Never estimate a timestamp from a summary, a runtime, or a guess about pacing —
a wrong boundary cuts mid-sentence and there is no way for the reader to tell
that it was invented.

If the subtitle text is mojibake, stop and ask for the encoding. Chinese
subtitles are frequently GBK, Japanese ones Shift-JIS. Do not transcribe
garbage or "reconstruct" what it probably said.

## Output format

```yaml
- name: "片段名称"
  description: "这一段发生了什么"
  start_time: 120.5
  end_time: 185.3
```

- `name` — short, concrete, ≤ 100 chars.
- `description` — 1–2 sentences, ≤ 500 chars. Optional but nearly always worth writing.
- `start_time` / `end_time` — seconds as floats. `end_time` must exceed `start_time`.

Optionally name the whole batch with a two-line header, which prefills the
归档 dialog on import:

```yaml
archive_name: "第 12 期精彩合集"
archive_description: "整场直播的高光"
- name: "开场打招呼"
  description: "观众进场，自我介绍。"
  start_time: 60.0
  end_time: 150.0
```

The header is optional, and one document may contain several — the parser only
reads entries beginning `- name:` and ignores every other line, so a plain list
and a multi-archive document both import.

## Writing the name

The name is read in a list, next to dozens of others, with no picture.

- **Say what happens, not what kind of thing it is.** `唱《恋爱循环》副歌` beats
  `唱歌片段`. `第三次掉下悬崖` beats `游戏失误`.
- **Do not number them.** `片段 1` carries nothing; the list is already ordered.
- **Do not restate the recording's title.** Every clip in the batch shares it.
- **Keep the subject's own words when they are the point** — a catchphrase, a
  line people will search for. Quote it: `"这我真的会谢"`.
- **Short.** A name that wraps to two lines in a narrow column stops scanning.

## Writing the description

- **Add what the name could not fit** — context, who else is involved, why it
  is worth the click. Do not paraphrase the name back.
- **Write it for someone who has not watched.** No `如上所述`, no `这里`.
- **No hype.** `笑翻全场！！！` tells the reader nothing; `讲错了自己的年龄，
  纠正了三次` tells them exactly what they are getting.
- **No spoiler of a punchline the clip exists to deliver** — set it up instead.
- Leave it `""` only when the name is genuinely complete on its own.

## Choosing boundaries

- **Start where the thing starts**, not at the previous silence. A few hundred
  ms of lead-in is fine; ten seconds of unrelated chatter is not.
- **End on the resolution** — the laugh, the answer, the last note. Cutting a
  beat early is the most common mistake.
- **One idea per clip.** If the description needs "然后", it is two clips.
- **Do not overlap** unless two clips deliberately frame the same moment
  differently; say so in the description when they do.
- 30–300s is the useful range. Shorter than ~15s rarely survives without
  context; longer than ~5min is a recording, not a clip.

Playback starts at or slightly before `start_time`: export snaps back to the
previous keyframe, in both the browser and the ffmpeg path. Do not try to
compensate — pick the honest time.

## Refining an existing list

The user may paste back an exported list (暂存区 → 📤 导出 YAML). Then:

- **Keep the `name` of any clip you did not change.** People sort and link by it.
- Preserve unchanged timestamps exactly, including their decimals.
- When merging two clips, take the earliest `start_time` and latest `end_time`
  and write a new description covering both — do not concatenate the old ones.
- Return the whole list, not a diff.

## How it is used

1. The user opens 切片页 → 🤖 AI 辅助, downloads this skill and the related files,
   and hands both to you.
2. You return YAML.
3. They paste it into 暂存区 → **📥 导入 YAML** → 「导入到暂存区」, or
   「导入为归档」 for a document with `archive_name:`.
4. They edit, archive, or publish from there.

## Example

For a singing stream, with subtitles supplied:

```yaml
archive_name: "11/03 歌回 高光"
archive_description: "整场唱了 9 首，这里是反应最好的四段。"
- name: "开场就破音，笑了三分钟"
  description: "第一首刚起调就破了，自己先笑场，重来两次才唱完整段。"
  start_time: 62.0
  end_time: 173.5
- name: "《恋爱循环》副歌"
  description: "全场跟唱最密的一段，弹幕刷满。"
  start_time: 1284.0
  end_time: 1361.2
- name: "读到自己三年前的投稿"
  description: "翻到一条旧留言，讲了当时为什么开始直播。整场唯一安静下来的地方。"
  start_time: 2510.8
  end_time: 2702.0
- name: "\"这我真的会谢\""
  description: "点歌点到自己最不想唱的一首，边吐槽边唱完了。"
  start_time: 3140.0
  end_time: 3298.6
```
