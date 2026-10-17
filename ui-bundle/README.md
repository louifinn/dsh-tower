# Tower UI（opt-in，未验证）

这是一个**可选**的 Web Client 小挂件：在输入框 dock 显示 `/tower` 命令提示。它只显示静态文案，不读取 Host 的实时模式状态。

## 为什么没有默认安装

- 本会话按约定**不做任何运行时测试**。Client 插件在真实页面中的 slot API、props 和渲染没有验证过，贸然安装可能影响 Web UI。
- 因此该 bundle 独立于 `@local/dsh-tower`，不影响主插件的安装与运行。

## 安装（需要一次允许测试的会话）

```text
plugin_manager({ action: "install_bundle", target: "<absolute path to this ui-bundle>" })
```

安装前请先在允许测试的会话确认：

1. `conversation.composer.dock` slot 仍存在（`Slots.listSubTree`）。
2. `ctx.slots.register` 接受的 options 与组件签名未变。
3. 页面输入框区域出现提示且无 console 报错；移除 bundle 后提示消失。

## 已知限制

- 不显示实时模式状态（没有 Host→Client 的 Remote 通道）。
- 只是提示，不是控制控件；模式切换仍通过 `/tower` 命令。
