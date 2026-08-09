# AI Clip Generation Skill

When a user asks you to generate clips/切片 for a video, output a YAML block
they can import directly into the clipping page.

## Output format

```yaml
- name: "片段名称"
  description: "简短描述（可选）"
  start_time: 120.5
  end_time: 185.3
- name: "第二段"
  description: ""
  start_time: 300.0
  end_time: 420.0
```

- `name` — 给这个片段的名称，应描述内容（如 "开场白", "副歌", "精彩击杀"）。
- `description` — 可选，更详细的描述。
- `start_time` / `end_time` — 秒数（浮点数），如 `120.5` = 2分0.5秒。

## How users import

1. 用户复制你输出的 YAML。
2. 在切片页面 (clip.html) 的暂存区点击 "📥 导入 YAML"。
3. 粘贴 YAML，片段出现在暂存区。
4. 用户可进一步编辑、归档或公开发布。

## How users export (for sharing with you)

1. 用户在暂存区或归档区点击 "📤 导出 YAML"。
2. 复制导出的 YAML 发给你。
3. 你可以基于它修改或补充更多片段。

## Guidelines for good clips

- 片段应有明确的起止边界 — 一句话、一段旋律、一个场景。
- 名称要描述内容，方便其他人浏览时理解。
- 时长不拘，但一般 30–300 秒最实用。
- 避免与已有片段高度重叠（除非从不同角度）。

## Example

For a hypothetical VUP singing stream:

```yaml
- name: "开场打招呼"
  description: "观众进场，自我介绍"
  start_time: 60.0
  end_time: 150.0
- name: "第一首歌 — 副歌"
  description: "高潮部分"
  start_time: 420.0
  end_time: 510.0
- name: "感谢 SC"
  description: "念感谢名单"
  start_time: 900.0
  end_time: 1020.0
```
