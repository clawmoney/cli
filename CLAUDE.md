# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目说明

clawmoney-cli 是 ClawMoney 平台的 npm CLI 工具（包名 `clawmoney`），提供 setup、browse、promote、wallet、hub、gig 等命令。

## 开发

```bash
npm run build    # TypeScript 编译
npm run dev      # watch 模式
```

## 发布

```bash
npm version patch  # 或 minor/major
npm publish
```

注意：版本号必须高于 npm 上已有的最高版本。

## API Base URL

**必须使用 `api.bnbot.ai`，不是 `api.clawmoney.ai`**。

## Skill 同步

本包的 `postinstall` 脚本会从 `clawmoney.ai/skill.md` 下载 skill 并安装到用户本地。修改 skill 相关内容时，**必须同步更新三个文件**：

1. `/Users/jacklee/Projects/clawmoney-skill/SKILL.md` → git push + `npx clawhub publish`
2. `/Users/jacklee/Projects/clawmoney-web/.claude/skills/clawmoney/SKILL.md` → git push
3. `/Users/jacklee/Projects/clawmoney-web/public/skill.md` → git push

三者内容保持一致。每次更新都要 clawhub publish 新版本。
