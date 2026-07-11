import { createRequire } from 'module'
import fs from 'node:fs'
import { close_api, delay, send, startService } from "./utils/utils.js";
import { printGreen, printMagenta, printRed, printYellow } from "./utils/colorOut.js";
import { summarizeResponse } from "./utils/safeLog.js";
import { upsertUser, saveUserinfo } from "./utils/userinfo.js";

const require = createRequire(import.meta.url)
const QRCode = require('./api/node_modules/qrcode')

// GitHub Actions 运行环境下，step summary 文件路径由该变量提供（Actions 自动注入）
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY
const QR_DIR = './qr'
const KEYS_FILE = './qrkeys.json'
const ASCII_FILE = `${QR_DIR}/qr-ascii.txt`   // 供「日志输出步骤」直接 cat 到运行日志
const URLS_FILE = `${QR_DIR}/qr-urls.txt`     // 扫码失败的链接兜底

/**
 * 渲染 QR 为 UTF-8 半块字符画（每个字符纵向承载 2 个模块），
 * 正好补偿终端字符“高>宽”的比例，在 GitHub Actions 运行日志里可直接用手机扫描。
 * 相比双宽 '██' 方案（横纵比 2:1 被拉伸、常扫不上），半块更接近正方形、可扫性更好。
 * @param {string} url
 * @returns {Promise<string>}
 */
function renderQrUtf8(url) {
  return QRCode.toString(url, { type: 'utf8', margin: 2 })
}

/**
 * 向 GitHub Step Summary 追加内容（本地或非 Actions 环境自动跳过）
 * @param {string} markdown
 */
function appendSummary(markdown) {
  if (!SUMMARY_FILE) return
  try {
    fs.appendFileSync(SUMMARY_FILE, markdown)
  } catch {
    // 写入摘要失败不影响主流程
  }
}

/**
 * 生成并落盘单个二维码：
 * - qr/qr-ascii.txt : UTF-8 半块字符画（日志输出步骤 cat 它即可在运行日志扫码）
 * - qr/qr-urls.txt  : 扫码失败的链接兜底
 * - qr/qr-N.png     : PNG 文件，供 artifact 下载
 * - Summary         : 以真实 PNG 图片（data URI）嵌入运行摘要，扫码页可直接查看
 * @param {string} url
 * @param {number} index 从 1 开始
 * @param {number} total
 */
async function buildQr(url, index, total) {
  const utf8 = await renderQrUtf8(url)
  const header = total > 1 ? `（第 ${index}/${total} 个账号）` : ''

  fs.mkdirSync(QR_DIR, { recursive: true })

  // ═══ 核心输出：直接将二维码打印到运行日志（用户展开此步骤即可看到并扫描）═══
  printMagenta(`\n╔══════════════════════════════════════════╗`)
  printMagenta(`║  请使用「酷狗音乐 APP」扫描下方二维码登录 ${header}  `)
  printMagenta(`╚══════════════════════════════════════════╝\n`)
  console.log(utf8)
  printMagenta('───────────────────────────────────────')
  printMagenta('如无法扫描，请复制此链接到酷狗 App 打开：')
  console.log(url)
  console.log('')

  // 落盘文件（供后续 cat 步骤 / artifact 双保险）
  const block = (total > 1 ? `# 账号 ${index}/${total}\n` : '') + utf8 + '\n'
  fs.appendFileSync(ASCII_FILE, block)
  fs.appendFileSync(URLS_FILE, (total > 1 ? `账号 ${index}/${total}: ` : '') + url + '\n')

  // 生成 PNG 文件（artifact 下载 + Summary 内嵌图片）
  await QRCode.toFile(`${QR_DIR}/qr-${index}.png`, url, { width: 320, margin: 2 })

  // 在运行摘要（Summary）中嵌入真实可扫的二维码图片
  const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
  appendSummary([
    `## 🎵 酷狗音乐扫码登录${header}`,
    '',
    '请使用 **酷狗音乐 APP** 扫描下方二维码登录（图片可在运行摘要页直接查看）：',
    '',
    `<img src="${dataUrl}" alt="酷狗扫码登录二维码${header}" width="320" />`,
    '',
    '如图片无法加载，可复制以下链接到浏览器/酷狗 App 打开：',
    '',
    url,
    '',
    '<details><summary>字符版二维码（备用）</summary>',
    '',
    '```',
    utf8,
    '```',
    '',
    '</details>',
    '',
    '---',
    '',
  ].join('\n'))
}

/** 解析账号数量 */
function resolveNumber() {
  const args = process.argv.slice(3) // 跳过 node、脚本名、模式参数
  return parseInt(process.env.NUMBER || args[0] || "1")
}

/**
 * 模式一：生成二维码并落盘（字符画文件 + PNG + Summary），随后立即结束 step。
 * 拆成独立 step 的目的：GitHub 会在 step 结束后刷新 Summary 页，
 * 同时由后续的「在运行日志中输出二维码」步骤把字符画 cat 进运行日志，用户在等待扫码期间可直接扫码。
 */
async function genMode() {
  const api = startService()
  await delay(2000)
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER
  const userinfo = (USERINFO && APPEND_USER == "是") ? JSON.parse(USERINFO) : []
  const number = resolveNumber()
  const keys = []
  try {
    // 预先清空上一次残留的字符画/链接文件
    for (const f of [ASCII_FILE, URLS_FILE]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }

    for (let n = 0; n < number; n++) {
      const result = await send(`/login/qr/key?timestrap=${Date.now()}`, "GET", {})
      if (result.status === 1) {
        const qrcode = result.data.qrcode
        const qrUrl = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${qrcode}`
        keys.push(qrcode)
        await buildQr(qrUrl, n + 1, number)
      } else {
        printRed("响应内容")
        console.dir(summarizeResponse(result), { depth: null })
        throw new Error(`获取二维码密钥失败：接口返回 status=${result.status}`)
      }
    }
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ number, keys }))
    printMagenta(`\n已生成 ${number} 个二维码（已直接显示在上方日志中）。`)
    printMagenta(`如上方二维码无法扫描，请前往【Summary 摘要】页查看清晰图片，或复制链接到酷狗 App 打开。`)
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    console.error(`::error::二维码生成失败：${msg}`)
    throw e
  } finally {
    close_api(api)
  }
}

/**
 * 模式二：读取已生成的二维码密钥，轮询等待用户扫码确认
 */
async function waitMode() {
  const api = startService()
  await delay(2000)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'))
  } catch {
    throw new Error("未找到二维码密钥文件，请确认已先运行“生成并展示二维码”步骤")
  }
  const { number, keys } = parsed
  const USERINFO = process.env.USERINFO
  const APPEND_USER = process.env.APPEND_USER
  const userinfo = (USERINFO && APPEND_USER == "是") ? JSON.parse(USERINFO) : []

  try {
    for (let n = 0; n < number; n++) {
      const qrcode = keys[n]
      printMagenta(`\n正在等待第 ${n + 1}/${number} 个账号扫码登录...`)
      let loggedIn = false
      for (let i = 0; i < 30; i++) {
        const timestrap = Date.now();
        const res = await send(`/login/qr/check?key=${qrcode}&timestrap=${timestrap}`, "GET", {})
        const status = res?.data?.status
        switch (status) {
          case 0:
            printYellow("二维码已过期，请重新运行工作流生成新二维码")
            break

          case 1:
            // 未扫描二维码
            break

          case 2:
            // 二维码未确认，请点击确认登录
            break

          case 4:
            printGreen("登录成功！")
            upsertUser(userinfo, { userid: res.data.userid, token: res.data.token }, APPEND_USER == "是")
            loggedIn = true
            break

          default:
            printRed("请求出错")
            console.dir(summarizeResponse(res), { depth: null })
        }
        if (loggedIn || status == 0) {
          break
        }
        if (i == 29) {
          printRed("等待超时\n")
        }
        await delay(5000)
      }
    }
    saveUserinfo(userinfo)
  } finally {
    close_api(api)
  }
}

const mode = process.argv[2] || 'gen'
if (mode === 'wait') {
  waitMode()
} else {
  genMode()
}
