# @lim324/dsh-video-summary · 视频总结

DSH Web GUI 插件:左侧边栏多一个「视频总结」入口,点开在主列显示所有总结过的视频。
粘一个链接回车 → 新开 DSH 会话 → agent 调 `video_summary` 工具把视频变成带时间戳的转录稿 →
写完总结再调 `video_summary_save` 存回面板。整个过程只在本机跑,音频不出门。

## 它解决什么

B 站/YouTube 的视频没法直接"喂"给模型:要么手动下字幕,要么把链接丢给 agent 让它自己 `yt-dlp` + 转写,
每次都要重新解释一遍流程。这个插件把「链接 → 转录稿 → 总结 → 归档」固化成一条流水线:

- **工具负责取数**:元数据、字幕(有就用)、音频、本地 faster-whisper 转录,都不需要 agent 自己拼命令;
- **面板负责归档**:每次总结都是一条记录,能搜、能回看文稿、能跳回那次会话;
- **数据在宿主磁盘上**:换浏览器/手机访问同一个 dsh 看到同一份记录。

## 三个工具

| 工具 | 干什么 |
| --- | --- |
| `video_summary({ url, force?, lang? })` | 取元数据 → 有字幕用字幕,否则下音频 + 本地 Whisper 转录 → 建/更新一条记录 → 返回带 `[mm:ss]` 的文稿。同一链接再调会直接回放已存记录(除非 `force: true`)。 |
| `video_summary_save({ id, summary, takeaways? })` | 把写好的总结存进那条记录,状态变「已总结」。 |
| `video_summary_list({ query?, limit? })` | 回看记录列表。 |
| `video_summary_transcript({ id, offset?, maxChars? })` | 分段读某条记录的完整文稿(长视频用)。 |

`video_summary` 还会把**发起调用的那个会话 id** 一起写进记录,所以面板里的「回到会话」能直接跳回当时的对话。

## 面板

- 顶部输入框:**粘链接 + 回车**,等价于对 agent 说「总结这个视频:<链接>」。任务文本会预填进新会话的输入框,回车即开跑。
- 列表:封面、标题、平台/作者/时长、状态徽章(转录中 / 待总结 / 已总结 / 失败)、字数、搜索与筛选。
- 详情:markdown 总结 + 要点 + 可展开的转录稿(带复制)。
- 删除:记录和 `transcripts/<id>.json` 一起删。

列表在**有任务转录中时每 3 秒自刷**,平时 20 秒;页面切到后台就停。

## 数据在哪(多设备必看)

```
$DSH_HOME/video-summary/
  library.json                 # 记录(标题/元数据/总结/状态/会话 id)
  library.json.bak             # 每次落盘前的上一版
  transcripts/<id>.json        # 转录稿(按需读,面板不一次拉全量)
  work/<id>/                   # 下载的音频,转录成功后默认删掉(keepAudio: true 可留)
```

- `VIDEO_SUMMARY_DIR` 环境变量或插件 config 的 `dataDir` 可以改目录(比如指到 iCloud 同步目录);
- 另一个 dsh 实例(另一个 `$DSH_HOME`)**不会**自动同步,想共享就指同一个 `dataDir`;
- 写到坏 JSON 时插件会拒绝写盘(不覆盖),用 `.bak` 手工恢复。

## 依赖

| 依赖 | 用途 | 检测方式 |
| --- | --- | --- |
| `yt-dlp` | 元数据 / 字幕 / 音频 | `GET /v-sum/health` 里的 `probe.ytDlp` |
| `ffmpeg` | faster-whisper 解码音频 | `probe.ffmpeg` |
| **mlx-whisper**(首选) | Apple GPU 转录,比 CPU 快约 4 倍 | `probe.asr.backend === "mlx"` |
| `python` + `faster-whisper`(兜底) | CPU 转录 | `probe.asr.backend === "faster-whisper"` |
| whisper 模型 | 吃 `~/.cache/huggingface/hub` 里已有的权重 | MLX 优先 large-v3-turbo;CPU 侧 large-v3-turbo → large-v3 → medium → small |

装 MLX 后端(一次就好,装在数据目录下的 venv 里,不污染系统 python):

```bash
uv venv --python /opt/homebrew/bin/python3.13 ~/.dsh/video-summary/venv
uv pip install --python ~/.dsh/video-summary/venv/bin/python mlx-whisper
# 没有 uv 的话:python3.13 -m venv ~/.dsh/video-summary/venv && ~/.dsh/video-summary/venv/bin/pip install mlx-whisper
```

同一个 4 分半视频的实测:**MLX 13 秒** / faster-whisper(CPU int8)**57 秒**。
没装 mlx-whisper 也不影响使用:探测不到就自动退到 CPU。

面板顶部会显示探测结果;缺东西时会红字提示哪个没找到。

## 配置(插件 config)

```yaml
- id: video-summary
  name: '@lim324/dsh-video-summary'
  config:
    maxChars: 24000      # 单次返回给模型的文稿上限(超出用 video_summary_transcript 续读)
    asrLang: zh          # ASR 语言
    asrBackend: auto     # auto | mlx | faster-whisper
    preferLangs: [zh-Hans, zh-CN, zh, en]
    keepAudio: false     # 转录完是否保留音频
    whisperModel: auto   # CPU 兜底用的模型
    mlxModel: ''         # MLX 用的模型(默认扫 hf 缓存里的 mlx-community/whisper-large-v3-turbo)
    mlxPythonPath: ''    # MLX venv 解释器(默认 <dataDir>/venv/bin/python)
    pythonPath: ''       # 指定解释器
    ytDlpPath: ''        # 指定 yt-dlp
    dataDir: ''          # 记录目录
```

## 路由

| 路由 | 说明 |
| --- | --- |
| `GET /v-sum/health` | 环境探测(yt-dlp/ffmpeg/python/模型)+ 计数 |
| `GET /v-sum/library?q=` | 记录列表(不含文稿正文) |
| `GET /v-sum/cover?u=<图片地址>` | 封面代理。B 站 CDN 有 Referer ACL,浏览器直连会被 403;这里带上正确 Referer 拉回来并缓存 |
| `GET /v-sum/item?id=` | 单条记录 + 转录稿分段 |
| `POST /v-sum/item` | 局部更新(`sessionId` / `summary` / `takeaways`) |
| `DELETE /v-sum/item?id=` | 删记录(连文稿、音频一起清) |

## 安装(本机)

```bash
git clone https://github.com/Limsanity/dsh-video-summary.git
cd dsh-video-summary
npm i --no-save esbuild   # 只在构建时需要

# 1. 构建(宿主 + 客户端 + asr.py / asr_mlx.py)
node build.mjs

# 2. 挂进 web profile(目录软链 + 依赖项)
ln -sfn "$PWD" ~/.dsh/profiles/web/node_modules/@lim324/dsh-video-summary
# package.json 的 dependencies 里加: "@lim324/dsh-video-summary": "link:<上面这个路径>"

# 3. 在 profile 的 cordis.patch.yml 末尾加一行(不要同时写进 dsh.profile.bundles,
#    否则同一插件会被 bundle patch 和用户 patch 各插一次 → 两行同 id)
- insert:
    - id: video-summary
      name: '@lim324/dsh-video-summary'
```

`cordis.patch.yml` 是 live reload 的:改完不用重启 dsh,插件行会热挂载(工具立刻可用),
刷新页面就能看到侧栏图标。

## 踩过的坑

- **不要既放进 `dsh.profile.bundles` 又在 `cordis.patch.yml` 里 `insert`**:两者的 `insert` 都会执行,
  `dsh --dump-config` 里会出现两行同 id。这里选了「只在用户 patch 里 insert」。
- **faster-whisper 的模型要传本地快照目录**:pyenv 的 python 如果没编 ssl,`huggingface_hub`
  的在线解析会直接 `SSL module is not available`。`resolveModel()` 因此优先扫本地 hub 缓存传绝对路径。
- **长音频别开 `condition_on_previous_text`**:会把一句尾巴滚成复读机(视频结尾那句重复就是这么来的)。
- **封面 403 是 Referer ACL,不是防盗链 cookie**:B 站 CDN 只放行空 Referer 或 bilibili.com 来源,
  从 `127.0.0.1:3080` 发起的图片请求会被 Tengine 直接 `denied by Referer ACL`。解法是宿主代理
  (`/v-sum/cover`,带 Referer + 内存缓存),客户端再补一个 `referrerPolicy="no-referrer"` 兜底。
- **工具输出要过 schema 校验**:`duration` 从 yt-dlp 来是浮点(269.566),schema 声明 `integer` 时
  整个工具结果会被判 invalid —— 出参前统一 `Math.round`。

## 许可

MIT
