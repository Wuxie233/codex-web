# Sub2API 语音转录与 Codex-web 403 调研

调研日期：2026-09-18。来源：Wei-Shaw/sub2api 官方源码与 PR，使用 GitHub API、浅克隆和固定提交读取；另用同账号、同出口和公开音频进行受控实测。

## 结论

本机受控实验与公网浏览器录音验收均成功：仅为转录 POST 补齐浏览器请求头即可恢复，无需新增 Go/TLS 依赖。

研究入口是尚未合并的 [PR #6537](https://github.com/Wei-Shaw/sub2api/pull/6537)。它同样调用 `https://chatgpt.com/backend-api/transcribe`，并针对上传使用 Chrome 133 TLS ClientHello 与一致的浏览器请求头。作者声称 Chrome 120 失败、Chrome 133 在六个 Pro 账号成功；作者的六账号声明未独立复现；本次环境的独立验证见文末。

当前主干 SHA `efe9aab1e4ec89a42ba45e8dac20e882c5409a6a` 未检出 OpenAI `/v1/audio/transcriptions` 或 `/backend-api/transcribe` 实现；音频转录代码主要是 Grok `/v1/stt`。仅根据主干会遗漏正在提议的真正相关解决方案。

## PR 状态与适用性

| 版本 | 状态（调研时） | 路径与意义 |
| --- | --- | --- |
| 主干 `efe9aab1e4ec` | 主干 | Grok STT → xAI API，不是我们的 ChatGPT 链路 |
| #6537 `15bfc21e62a6` | OPEN | OAuth → ChatGPT `/backend-api/transcribe`；API key → OpenAI-compatible `/v1/audio/transcriptions`；有专用 Chrome 133 上传客户端 |
| #6503 `bc8b04a582982dd3caec00f7a0d3592af9535482` | OPEN | 只支持 OpenAI API key，明确拒绝其他账户类型；不解决 ChatGPT OAuth 转录 |
| #3276 `ab3684958152` | CLOSED，未合并 | 旧 OAuth/API key 转录实现，作者称本地成功；没有 #6537 的专用 Chrome 133 上传客户端 |

PR 状态来源：[6537](https://github.com/Wei-Shaw/sub2api/pull/6537)、[6503](https://github.com/Wei-Shaw/sub2api/pull/6503)、[3276](https://github.com/Wei-Shaw/sub2api/pull/3276)。#6503 的实现及 mock 测试也已核验：[ForwardTranscriptions 源码](https://github.com/Wei-Shaw/sub2api/blob/bc8b04a582982dd3caec00f7a0d3592af9535482/backend/internal/service/openai_transcriptions.go#L1)。

## #6537 的具体实现

1. **没有更换 OAuth 上游**：`chatgptTranscribeURL` 仍是 `https://chatgpt.com/backend-api/transcribe`。API key 才走另一条正式 API 路径。[上游与分派](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_forward.go#L21-L58)
2. **专用 TLS/HTTP 客户端**：`req.C().ImpersonateChrome()` 后调用 `SetTLSFingerprint(utls.HelloChrome_Auto)`，配套 Chrome/133 UA、`sec-ch-ua`、`accept-language`。依赖为 `github.com/imroc/req/v3 v3.59.0`、`github.com/refraction-networking/utls v1.8.2`；不能把任意新版 `HelloChrome_Auto` 都当作此固定指纹。支持每账号代理，上传客户端独立连接池、120 秒超时；上游请求另设 110 秒预算。[TLS 与头](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/repository/req_client_pool.go#L23-L35)、[构造客户端](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/repository/req_client_pool.go#L62-L79)、[独立上传池](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/repository/req_client_pool.go#L109-L119)、[依赖版本](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/go.mod#L1)
3. **认证仍然必需**：从 OAuth token provider 取 access token；`Authorization: Bearer ...`，并通过 `resolveAndSetOpenAIChatGPTAccountHeaders` 添加账户头。不是靠删除认证恢复。[凭据与账户头](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_forward.go#L79-L93)
4. **XHR 风格请求头**：`Accept: application/json`、`Origin: https://chatgpt.com`、`Referer: https://chatgpt.com/`、`sec-fetch-mode: cors`、`sec-fetch-site: same-origin`、`sec-fetch-dest: empty`。没有在该转录函数里设置浏览器 cookie、`cf_clearance`、Sentinel token 或执行 JS 验证。[请求构造](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_forward.go#L99-L129)
5. **OAuth multipart 只发 file**：保留 filename、文件 MIME、字节；该函数没有上传 language/model/prompt。模型名用于计费/响应适配，不能把 OpenAI ASR 模型参数机械地传给私有 dictation endpoint。API key 分支则转发 multipart，按映射修改 model。[OAuth 文件](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_forward.go#L113-L129)、[API key 分支](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_forward.go#L243-L300)
6. **没有把所有 403 当封号**：Cloudflare challenge 识别后返回 502，记录 cf-ray，不轮换账号重复上传；普通 401/403 才可 failover，但不修改账号状态。429/5xx 才进入通常账户错误处理。[CF 分流](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_forward.go#L148-L168)、[其他状态](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_forward.go#L191-L239)

### 证据强度

- PR 描述声称六个 Pro 账号生产验证，英语 WAV、中文 MP3、JSON/text 响应成功。这是贡献者声明，未看到原始请求/响应审计资料，PR 作者的六账号结果未独立复现；本次单账号结果见下文。
- 源码测试使用 `httptest.NewServer` 作为 ChatGPT 目标，覆盖 multipart、响应转换、CF 错误不 failover、401、413 等；能证明这些逻辑的测试设计，不能证明公网 TLS 被 Cloudflare 接受。[mock 服务](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_test.go#L220-L262)、[CF 测试](https://github.com/Wei-Shaw/sub2api/blob/15bfc21e62a655ed4fa69d22b2b6c5c2fa92bf78/backend/internal/service/openai_audio_transcriptions_test.go#L354-L387)
- 本次没有运行其 Go 测试，避免把阅读测试代码描述成测试通过；PR 自述测试通过同样只归属作者。

## #3276 的区别

旧方案同样使用 ChatGPT `/backend-api/transcribe`。OAuth 发 `file` 与非空 `prompt`，不发 model 或 API 额外字段；带 Bearer 和可选 chatgpt-account-id，转发来访 UA、x-openai-*、x-codex-*，没有 UA 时显式置空，最终调用常规 `httpUpstream.Do`。因此它没有 #6537 这次 Chrome 133 专用上传配置，不能作为同一方法的成功证据。[OAuth 请求与请求头](https://github.com/Wei-Shaw/sub2api/blob/ab36849581520b2d446b5acdcbc904e439277772/backend/internal/service/openai_audio_transcriptions.go#L321-L369)、[传输](https://github.com/Wei-Shaw/sub2api/blob/ab36849581520b2d446b5acdcbc904e439277772/backend/internal/service/openai_audio_transcriptions.go#L401-L425)、[multipart](https://github.com/Wei-Shaw/sub2api/blob/ab36849581520b2d446b5acdcbc904e439277772/backend/internal/service/openai_audio_transcriptions.go#L523-L571)

作者在 [PR 评论](https://github.com/Wei-Shaw/sub2api/pull/3276#issuecomment-4722032384) 称本地测过；PR 于 2026-08-21 关闭且 mergedAt 为空。它的状态不等于已有正式发布支持。

## 主干 Grok 路径，避免混淆

主干 `/v1/stt` 限 Grok 分组，默认到 `https://api.x.ai/v1/stt`；当配置为 CLI chat proxy 时，语音 URL 会回退官方 xAI API，因为 CLI proxy 不提供语音。OAuth 取 Grok access token，API-key 取 xAI API key。转发原始 body 与 Content-Type，设置 Bearer、Accept，调用常规 `httpUpstream.Do`，而不是专用 DoWithTLS。[路由](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/server/routes/gateway.go#L287-L300)、[语音URL](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/service/grok_upstream_url.go#L144-L176)、[转发实现](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/service/grok_audio.go#L60-L104)、[凭据](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/service/openai_gateway_service.go#L1210-L1260)

主干 README 仍写 transcription 不在该 provider 范围，但代码已有 Grok STT，说明文档落后；本报告以具体代码为准。测试还存在细节差异：实际转发只对 CLI proxy 加 CLI headers，账户测试函数却对全部 Grok OAuth 加；不能把测试入口成功等同生产转发成功。[README](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/README.md#L743-L755)、[生产请求头条件](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/service/grok_audio.go#L84-L88)、[账户测试头](https://github.com/Wei-Shaw/sub2api/blob/efe9aab1e4ec89a42ba45e8dac20e882c5409a6a/backend/internal/service/account_test_service.go#L1740-L1748)

## 对 Codex-web 的行动含义

修复前的 Codex-web 源码对照：前端 multipart 已有 file 和可选 language；后端调用相同 ChatGPT `/backend-api/transcribe`，已有 Authorization、ChatGPT-Account-Id、originator 和 Codex Desktop UA；Electron `net.fetch` shim 最终用 Node `globalThis.fetch`。所以不能诊断成缺少 token/UA；值得隔离实验的是 **Node 传输与 #6537 固定 Chrome 133 TLS/HTTP 特征的一致性**，而不是继续只改普通请求头。

### 受控实测与修复

同账号、同出口、同一段两秒静音音频下，Node 只带认证和账户头得到 403 Cloudflare challenge；Node 补齐 PR 的浏览器头得到 200 JSON `{text}`；固定依赖版本的 Go req/uTLS 客户端也得到 200。因此本次环境中完整请求头已经足够，无需新增 Go 或 TLS 依赖；这不证明每一个头都必需，也不保证所有出口都适用。

再使用公开的 [whisper.cpp JFK WAV 样本](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav)，Node 完整头返回 200，识别文本与该段已知讲话一致。该证据证明直接请求能识别有声音频；它与浏览器完整录音链路验收分别记录。

修复位于 `src/server/electron/transcription-headers.ts`，由 Electron `net.fetch` shim 调用。只对精确的 HTTPS 转录地址及 POST 补充上述浏览器头，保留原认证、账户、multipart 音频、取消信号与其余请求选项。其他接口保持原行为，不增加服务或依赖。

验证：服务端 TypeScript 构建通过；现有与新增 Node 测试共 39/39 通过，覆盖地址/方法作用域、三种 HeadersInit、调用方不变及认证、body、signal 保留。公网 Chromium 使用该已知 WAV 作为模拟麦克风，实际执行听写开始、录音、停止、上传和识别回填，输入框出现匹配的识别文本；测试后通过 ProseMirror 文档相等检查确认原草稿已恢复，未发送消息。服务重启后状态正常。这是浏览器模拟麦克风证据，不是手机实机麦克风验收。
