# dsh-ask-chime

> 当 DeepSeek Harness 需要问你、或者把活干完的时候，在你的电脑上响一声。

[English](README.en.md) | 中文

提问的时候、审批卡住的时候、以及它干完活的时候，你多半都不在看窗口。前两者会一直等你，后者你可能要过很久才发现——它们都不会主动叫你。这个插件就是补上那三声。

```
🔔 提问  → Windows 钟琴声 + 下行双音
🔔 审批  → Windows 日历通知 + 上行双音
✅ 完成  → Windows Print complete + 三音上行
```

三种提示音的音高走向各不相同（降、升、上行三音），闭着眼睛也能分辨是"要我回答"还是"干完了"。

## 它挂在哪三个点上

| 时机 | 信号 | 说明 |
| --- | --- | --- |
| 需要问你 | `ctx.userQuestions.ask()` | `ask_user_question` 工具与计划评审（`exit_plan_mode`）**都走这一个方法**，所以包一层就全覆盖，将来新增的提问工具也自动生效 |
| 需要你审批 | `approval/request` | 这个是 waterfall，只在策略真的去问人时才派发；被策略自动拒绝的调用不会响 |
| 干完了 | `agent/status` 的 `running → idle` | 这正是 Web UI 判断"会话是否在忙"用的同一个信号，所以它表示的是**活停了**，而不是"回复写完了"。只对**根代理**响，子代理中途收工不会打扰你 |

包装只会"响一声然后原样转发"，提问本身不受任何影响；声音失败（没有播放器、静音、音效文件丢失）也永远不会影响它所播报的那次提问或那个回合。

## 安装

```sh
# 从 GitHub 安装到某个 profile（本插件的 cordis.patch.yml 会自动插入插件行）
dsh plugin --profile web add github:SwallowData/dsh-ask-chime
```

装完**重启 DSH**：profile 的 composition 在下次启动时才展开。

本地开发时直接指向目录即可：

```sh
git clone https://github.com/SwallowData/dsh-ask-chime
dsh plugin --profile web add /path/to/dsh-ask-chime
```

## 配置

插件行由包内的 `cordis.patch.yml` 插入，可以在 profile 的 `cordis.patch.yml` 里覆盖同一行来加配置：

```yaml
- insert:
    - id: ask-chime
      name: 'dsh-ask-chime'
      config:
        enabled: true                      # 总开关
        questions: true                    # 提问时响
        approvals: true                    # 审批时响
        completed: true                    # 干完时响（仅根代理）
        tones: true                        # 仅 Windows：在 wav 之后追加尾音
        minTurnMs: 0                       # 短于这个毫秒数的回合不响（0 = 都响）
        questionSound: chimes.wav          # 平台默认音效，或绝对路径
        approvalSound: null                # null 表示用平台默认
        completedSound: null               # null 表示用平台默认
```

`minTurnMs` 默认是 0（每回合都响）。如果你觉得"随手问一句也叮一下"太吵，把它设成比如 `5000`，短回合就会被静音——这也是唯一一个**只在完成提示音上生效**的开关。

## 声音

| 平台 | 提问 | 审批 | 完成 |
| --- | --- | --- | --- |
| Windows | `chimes.wav` + 下行双音 | `Windows Notify Calendar.wav` + 上行双音 | `Windows Print complete.wav` + 三音上行 |
| macOS | `Glass.aiff` | `Ping.aiff` | `Hero.aiff` |
| Linux | `dialog-question.oga` | `message.oga` | `complete.oga` |

Windows 上故意先放 wav、再补一段尾音：有些机器的声音方案把通知音设成了「无」，此时 wav 依然会响；而尾音由系统直接合成，走默认输出设备，躲不掉。

## 平台支持

- **Windows：已实测。** `powershell.exe`（系统自带）在无控制台、隐藏窗口的 spawn 下，wav 播放与 `[console]::beep` 都正常。
- **macOS / Linux：实现了但未实测**（`afplay` / `paplay`·`pw-play`·`aplay` 依次尝试）。欢迎 PR 补实测结果。

## 设计说明与取舍

- **为什么是"包一层 `ask`"**：DSH 的 `userQuestions` 只允许注册**一个** provider，而 Web 端已经占了它，没有留给第三方插件的订阅口。所以这里包住那个方法，并且：只在没包过时包、卸载时只删自己那一层、后面有人再包不会被我覆盖。
- **为什么不走 harness 的 shell 服务**：这个插件用 `node:child_process` 直接跑一条固定命令，而不是 `ctx.shell`。原因是 shell 服务会用部署的沙箱策略约束每次执行，而**无会话（agentless）的插件调用在默认 `workspace-write` 沙箱下连 `echo hello` 都会失败**（Windows 上实测：exit 1 且无任何输出）；同一条命令在显式策略下则正常。这里生成的命令是固定的、不接收任何来自模型或会话的输入，且只做一件事：发声。
- **为什么"干完了"用 `agent/status`**：它在状态**真正变化**时才派发，`idle` 就是没有任何在跑的回合；Web UI 也用它来决定会话是否显示忙碌。比 `agent/turn-stopping` 准——那个只是"回合即将关闭"，不区分之后是否马上又忙起来。另外：手动打断和回合报错最后也会走到 `idle`，所以同样会响（都算结束了）。
- **为什么子代理不响**：子代理也是 Agent，也会发 `agent/status`。用 `agents.roots()` 过滤成只看根代理，否则一个任务期间会被子代理的收工打断好几次。
- **失败被完全隔离**：播放器缺失、机器静音、音效文件不存在，都只会打一条 warning，绝不会打断它所播报的那次提问、审批或回合。

## 测试

```sh
npm test        # node --test，32 个用例
```

不联网、不起进程、不依赖平台：通过 `install()` 的测试接缝（假 ctx + 假播放器）与 `buildCommands()` 的显式 `platform` 参数驱动全部行为。

## 许可

[MIT](LICENSE)
