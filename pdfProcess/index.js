/**
 * PDF小助手 Pro 云函数后端（pdfProcess）
 * 本程序以 GNU AGPL-3.0 发布，完整条款见同目录 LICENSE，第三方组件声明见 NOTICE
 * 源码地址：https://github.com/JIAOMAX1/pdf-tools-backend
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const fs = require('fs')
const path = require('path')

// Node < 18 无全局 WebCrypto，@cantoo 加密需要 crypto.getRandomValues
if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto = require('crypto').webcrypto
}

// 使用支持 PDF 加密/解密的 fork（官方 pdf-lib 不实现加密保存）
const { PDFDocument, StandardFonts, degrees, rgb } = require('@cantoo/pdf-lib')
const fontkit = require('@pdf-lib/fontkit')
// 页面渲染用官方 MuPDF.js（WASM，内置 CJK 回退字体，可渲染未嵌入字体的中文）
// 注意：MuPDF.js 为 AGPL-3.0-or-later 许可，对外商用需自行评估/购买商业授权
const JSZip = require('jszip')

// ============================================
// 工具函数
// ============================================

function hexToRgb(hex) {
  let value = String(hex || '#000000').replace('#', '')
  if (value.length === 3) {
    value = value.split('').map((c) => c + c).join('')
  }
  const num = parseInt(value, 16)
  return rgb(((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255)
}

/** "1-3,5,8-10" -> [1,2,3,5,8,9,10]（去重、升序、1 起始） */
function expandPages(text) {
  const set = new Set()
  for (const part of String(text || '').split(',')) {
    const seg = part.trim()
    if (!seg) continue
    if (seg.includes('-')) {
      const [a, b] = seg.split('-').map((x) => parseInt(x, 10))
      if (isNaN(a) || isNaN(b)) continue
      for (let i = a; i <= b; i++) set.add(i)
    } else {
      const n = parseInt(seg, 10)
      if (!isNaN(n)) set.add(n)
    }
  }
  return [...set].sort((x, y) => x - y)
}

/**
 * 计算「把指定页面移动到某一页之后」的新页序（1 起始）。
 * moveText：要移动的页码，支持 "3"、"3,5"、"3-5"
 * afterText：移动到第几页之后，0 表示移到最前面
 */
function parseMoveOrder(moveText, afterText, totalPages) {
  const moveSet = new Set(expandPages(moveText))
  if (!moveSet.size) throw new Error('请输入需要调整的页码')
  for (const n of moveSet) {
    if (n < 1 || n > totalPages) {
      throw new Error(`页码 ${n} 超出文档范围（共 ${totalPages} 页）`)
    }
  }
  const after = parseInt(String(afterText).trim(), 10)
  if (isNaN(after) || after < 0 || after > totalPages) {
    throw new Error(`「调整在第几页之后」请填 0-${totalPages} 之间的页码，0 表示移到最前面`)
  }
  if (after !== 0 && moveSet.has(after)) {
    throw new Error('「调整在第几页之后」的页码不能与需要调整的页码相同')
  }
  const moved = [...moveSet].sort((a, b) => a - b)
  const rest = []
  for (let i = 1; i <= totalPages; i++) {
    if (!moveSet.has(i)) rest.push(i)
  }
  if (after === 0) return [...moved, ...rest]
  const idx = rest.indexOf(after)
  return [...rest.slice(0, idx + 1), ...moved, ...rest.slice(idx + 1)]
}

async function downloadFile(fileID) {
  const res = await cloud.downloadFile({ fileID })
  return res.fileContent
}

/** 上传结果文件到云存储并登记 24h 清理 */
async function uploadResult(prefix, buffer, fileName) {
  const cloudPath = `${prefix}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${fileName}`
  const res = await cloud.uploadFile({ cloudPath, fileContent: buffer })
  try {
    await db.collection('files').add({ data: { fileID: res.fileID, createdAt: db.serverDate() } })
  } catch (err) {
    console.warn('[pdfProcess] register result error:', err)
  }
  return { fileID: res.fileID, name: fileName, size: buffer.length }
}

async function uploadPdf(pdfDoc, prefix, fileName) {
  const bytes = await pdfDoc.save()
  return uploadResult(prefix, Buffer.from(bytes), fileName)
}

// ============================================
// 各处理动作
// ============================================

/** 拆分 */
async function split(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = source.getPageCount()
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const groups = [] // 每组为 1 起始页码数组
  if (options.mode === 'single') {
    for (let i = 1; i <= total; i++) groups.push([i])
  } else {
    const ranges = String(options.ranges || '').split(',')
    for (const part of ranges) {
      const seg = part.trim()
      if (!seg) continue
      const list = expandPages(seg).filter((n) => n >= 1 && n <= total)
      if (list.length) groups.push(list)
    }
  }
  const outputs = []
  for (let g = 0; g < groups.length; g++) {
    const pageList = groups[g]
    const out = await PDFDocument.create()
    const pages = await out.copyPages(source, pageList.map((n) => n - 1))
    pages.forEach((p) => out.addPage(p))
    // 命名：单页显示实际页码，多页显示页码范围，如 合同_第5页.pdf / 合同_第1-3页.pdf
    const first = pageList[0]
    const last = pageList[pageList.length - 1]
    const name = first === last ? `${base}_第${first}页.pdf` : `${base}_第${first}-${last}页.pdf`
    const item = await uploadPdf(out, 'result', name)
    outputs.push({ ...item, pageCount: out.getPageCount() })
  }
  return outputs
}

/** 合并多份 PDF */
async function merge(fileIDs, options, inputName) {
  const out = await PDFDocument.create()
  let total = 0
  for (const fileID of fileIDs) {
    const buf = await downloadFile(fileID)
    const src = await PDFDocument.load(buf, { ignoreEncryption: true })
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
    total += src.getPageCount()
  }
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadPdf(out, 'result', `${base}_合并.pdf`)
  return [{ ...item, pageCount: total }]
}

/** 删除页面 */
async function deletePages(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = source.getPageCount()
  const toDelete = new Set(expandPages(options.pages))
  const out = await PDFDocument.create()
  const keepIndices = []
  for (let i = 0; i < total; i++) {
    if (toDelete.has(i + 1)) continue
    keepIndices.push(i)
  }
  const pages = await out.copyPages(source, keepIndices)
  pages.forEach((p) => out.addPage(p))
  let kept = pages.length
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadPdf(out, 'result', `${base}_删页后.pdf`)
  return [{ ...item, pageCount: kept }]
}

/** 旋转页面 */
async function rotatePages(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = source.getPageCount()
  const angle = degrees(parseInt(options.angle || '90', 10) || 90)
  const targets = options.pages ? new Set(expandPages(options.pages)) : null
  for (let i = 0; i < total; i++) {
    if (targets && !targets.has(i + 1)) continue
    source.getPage(i).setRotation(angle)
  }
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadPdf(source, 'result', `${base}_旋转后.pdf`)
  return [{ ...item, pageCount: total }]
}

/** 重排页面：把指定页面移动到某一页之后 */
async function reorderPages(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = source.getPageCount()
  const order = parseMoveOrder(options.movePages, options.afterPage, total)
  const out = await PDFDocument.create()
  const pages = await out.copyPages(source, order.map((n) => n - 1))
  pages.forEach((p) => out.addPage(p))
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadPdf(out, 'result', `${base}_重排后.pdf`)
  return [{ ...item, pageCount: total }]
}

/**
 * 根据位置与间距计算文本起点坐标
 * vEdge：文本与顶部/底部边缘的间距（上下间距）
 * hEdge：文本与左侧/右侧边缘的间距（左右间距，居中时不影响横向居中）
 * textWidth：文本实际宽度，用于右对齐 / 居中精确排版
 */
function positionOf(pos, width, height, fontSize, vEdge, hEdge, textWidth) {
  const v = Number.isFinite(Number(vEdge)) ? Math.max(0, Number(vEdge)) : 24
  const h = Number.isFinite(Number(hEdge)) ? Math.max(0, Number(hEdge)) : 24
  const tw = Number(textWidth) > 0 ? Number(textWidth) : 30
  // 直觉语义：间距 = 文字到对应纸边的实际留白
  const yBottom = v // 文字基线距底边的距离
  const yTop = height - (v + fontSize) // 文字顶部距页顶约等于 v
  switch (pos) {
    case 'bottomLeft':
      return { x: h, y: yBottom }
    case 'bottomRight':
      return { x: width - h - tw, y: yBottom }
    case 'topLeft':
      return { x: h, y: yTop }
    case 'topCenter':
      return { x: (width - tw) / 2, y: yTop }
    case 'topRight':
      return { x: width - h - tw, y: yTop }
    case 'center':
      return { x: (width - tw) / 2, y: (height - fontSize) / 2 }
    case 'bottomCenter':
    default:
      return { x: (width - tw) / 2, y: yBottom }
  }
}

/** 添加页码 */
async function addPageNumbers(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = source.getPageCount()
  const font = await source.embedFont(StandardFonts.Helvetica)
  const start = Math.max(1, parseInt(options.start || '1', 10) || 1)
  const fontSize = parseInt(options.fontSize || '12', 10)
  const color = hexToRgb(options.fontColor)
  const position = options.position || 'bottomCenter'
  const showFirst = options.firstPage !== false
  for (let i = 0; i < total; i++) {
    if (i === 0 && !showFirst) continue
    const page = source.getPage(i)
    const { width, height } = page.getSize()
    const text = String(start + i)
    const textWidth = font.widthOfTextAtSize(text, fontSize)
    const pos = positionOf(
      position,
      width,
      height,
      fontSize,
      options.verticalEdge,
      options.horizontalEdge,
      textWidth
    )
    page.drawText(text, {
      x: pos.x,
      y: pos.y,
      size: fontSize,
      font,
      color,
      opacity: 0.9
    })
  }
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadPdf(source, 'result', `${base}_已编页.pdf`)
  return [{ ...item, pageCount: total }]
}

// 中文字体：自动加载 fonts/ 目录下首个 TTF/OTF 字库，首次读入后常驻内存
// 出于字体授权考虑，本仓库不内置字库，请自行放置你拥有合法授权的字体文件
// 请勿使用 SimHei（中易黑体）等需商业授权的字体，除非你已获得相应授权
let cjkFontCache = null
function getCjkFontBytes() {
  if (cjkFontCache) return cjkFontCache
  const fontDir = path.join(__dirname, 'fonts')
  const exts = ['.ttf', '.otf']
  let fontPath = ''
  if (fs.existsSync(fontDir)) {
    const file = fs
      .readdirSync(fontDir)
      .sort()
      .find((name) => exts.includes(path.extname(name).toLowerCase()))
    if (file) fontPath = path.join(fontDir, file)
  }
  if (!fontPath) {
    throw new Error('云函数缺少中文字库，请在 fonts/ 目录放置一个 TTF/OTF 字体文件后重新部署')
  }
  console.log(`[pdfProcess] 使用中文字库: ${path.basename(fontPath)}`)
  cjkFontCache = fs.readFileSync(fontPath)
  return cjkFontCache
}

/** 添加文字水印（中文 / 英文 / 数字 / 常用符号均支持） */
async function watermark(fileIDs, options, inputName) {
  const text = String(options.text || '').trim()
  if (!text) throw new Error('请输入水印文字')
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  // 该版本 pdf-lib 的 fontkit 需在文档实例上注册，自定义字体才能解析
  source.registerFontkit(fontkit)
  const total = source.getPageCount()
  // 含中文/非拉丁字符时嵌入中文字库，否则用标准 Helvetica 减小体积
  const needCjk = /[^\x00-\x7F]/.test(text)
  let font
  if (needCjk) {
    font = await source.embedFont(getCjkFontBytes())
  } else {
    font = await source.embedFont(StandardFonts.Helvetica)
  }
  const fontSize = parseInt(options.fontSize || '28', 10)
  const opacity = Math.max(0.05, Math.min(1, (parseInt(options.opacity || '25', 10) || 25) / 100))
  const color = hexToRgb('#000000')
  const position = options.position || 'center'
  const textWidth = font.widthOfTextAtSize(text, fontSize)
  for (let i = 0; i < total; i++) {
    const page = source.getPage(i)
    const { width, height } = page.getSize()
    if (position === 'center') {
      // 对角铺满平铺
      const gap = Math.max(height, width) / 3
      for (let gx = -height; gx < width + height; gx += gap) {
        for (let gy = -height; gy < height + height; gy += gap) {
          page.drawText(text, {
            x: gx + gy / 2,
            y: gy,
            size: fontSize,
            font,
            color,
            opacity,
            rotate: degrees(-30)
          })
        }
      }
    } else {
      const pos = positionOf(position, width, height, fontSize, undefined, undefined, textWidth)
      page.drawText(text, {
        x: pos.x,
        y: pos.y,
        size: fontSize,
        font,
        color,
        opacity
      })
    }
  }
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadPdf(source, 'result', `${base}_水印.pdf`)
  return [{ ...item, pageCount: total }]
}

/** 设置密码 */
async function encrypt(fileIDs, options, inputName) {
  const password = String(options.password || '')
  if (password.length < 4) throw new Error('密码至少 4 位')
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = source.getPageCount()
  // RC4-128（PDF 1.4 / V2 R3）兼容性最佳，主流阅读器与微信内置预览均可正常打开。
  // 注意：须先调用 encrypt() 再 save()，save 的 options 不接收 encrypt 参数（会被静默忽略导致未加密）
  source.encrypt({
    userPassword: password,
    ownerPassword: password,
    permissions: { printing: true, copying: true, modifying: true },
    algorithm: 'RC4-128',
    allowWeakCryptography: true
  })
  const bytes = await source.save()
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadResult('result', Buffer.from(bytes), `${base}_加密.pdf`)
  return [{ ...item, pageCount: total }]
}

/** 移除密码 */
async function decrypt(fileIDs, options, inputName) {
  const password = String(options.password || '')
  if (!password) throw new Error('请输入原始 PDF 密码')
  const buf = await downloadFile(fileIDs[0])
  let source
  try {
    source = await PDFDocument.load(buf, { password })
  } catch (err) {
    console.error('[pdfProcess] decrypt load error:', err)
    throw new Error('密码错误，请输入正确的原始 PDF 密码')
  }
  const total = source.getPageCount()
  const bytes = await source.save()
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadResult('result', Buffer.from(bytes), `${base}_解密.pdf`)
  return [{ ...item, pageCount: total }]
}

/** 压缩（清理冗余元数据并重建对象流，文本类效果有限） */
async function compress(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  const source = await PDFDocument.load(buf, { ignoreEncryption: true })
  const total = source.getPageCount()
  const bytes = await source.save({ useObjectStreams: true })
  const base = String(inputName || 'document').replace(/\.pdf$/i, '')
  const item = await uploadResult('result', Buffer.from(bytes), `${base}_压缩.pdf`)
  return [{ ...item, pageCount: total }]
}

/** PDF 转文本（使用 MuPDF 逐页提取，尽量保留完整文字内容） */
async function pdf2text(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  let mupdf
  try {
    mupdf = await import('mupdf')
  } catch (err) {
    console.error('[pdfProcess] mupdf import error:', err)
    throw new Error('文本提取引擎未安装，请重新部署云函数依赖')
  }

  let document
  try {
    document = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    if (document.needsPassword()) {
      throw new Error('该 PDF 已设置打开密码，请先解密后再转换')
    }

    const total = document.countPages()
    const pages = []

    for (let i = 0; i < total; i++) {
      const page = document.loadPage(i)
      try {
        const structured = page.toStructuredText()
        pages.push(structured.asText())
      } finally {
        page.destroy()
      }
    }

    const text = pages.join('\n\n').replace(/\r\n/g, '\n').trim()
    if (!text) {
      throw new Error('未能提取到文字，该文件可能为扫描版（图片型）PDF')
    }

    const base = String(inputName || 'document').replace(/\.pdf$/i, '')
    const item = await uploadResult('result', Buffer.from(text, 'utf8'), `${base}.txt`)
    return [{ ...item, pageCount: total }]
  } finally {
    if (document) document.destroy()
  }
}

/** PDF 转图片（MuPDF.js WASM 渲染；内置 CJK 字体回退，未嵌入字体的中文也能正常渲染） */
async function pdf2image(fileIDs, options, inputName) {
  const buf = await downloadFile(fileIDs[0])
  const format = options.format === 'png' ? 'png' : 'jpg'
  const dpi = Math.max(60, Math.min(300, parseInt(options.dpi, 10) || 150))
  const MAX_PAGES = 50

  let mupdf
  try {
    mupdf = await import('mupdf')
  } catch (err) {
    console.error('[pdfProcess] mupdf import error:', err)
    throw new Error('页面渲染引擎未安装，请重新部署云函数依赖')
  }

  let document
  try {
    try {
      document = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
    } catch (err) {
      throw new Error('无法解析该 PDF，文件可能已损坏或格式异常')
    }
    // mupdf 不会因加密抛错，需显式检查
    if (document.needsPassword()) {
      throw new Error('该 PDF 已设置打开密码，请先用「移除 PDF 密码」解密后再转换')
    }
    const total = document.countPages()
    if (total > MAX_PAGES) {
      throw new Error(`该 PDF 共 ${total} 页，单次最多转换 ${MAX_PAGES} 页，请先用「PDF 拆分」分块处理`)
    }
    if (total < 1) throw new Error('PDF 内没有可渲染的页面')

    const base = String(inputName || 'document').replace(/\.pdf$/i, '')
    const outputs = []
    const pageBlobs = [] // { name, buf }，供打包压缩包使用

    // PDF 以 72dpi 为基准，scale = dpi / 72；mupdf 渲染自动处理页面方向
    const scale = dpi / 72
    const matrix = mupdf.Matrix.scale(scale, scale)
    for (let i = 0; i < total; i++) {
      const page = document.loadPage(i)
      let pix
      try {
        pix = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)
        const bytes = Buffer.from(
          format === 'png' ? pix.asPNG() : pix.asJPEG(88)
        )
        const name = `${base}_第${i + 1}页.${format}`
        pageBlobs.push({ name, buf: bytes })
        const item = await uploadResult('result', bytes, name)
        outputs.push({ ...item, pageCount: 1 })
      } finally {
        if (pix) pix.destroy()
        page.destroy()
      }
    }

    // 额外打包一个 ZIP 压缩包，方便用户一次性下载/转发全部图片
    let zipFile = null
    const totalBytes = pageBlobs.reduce((s, p) => s + p.buf.length, 0)
    if (pageBlobs.length > 1 && totalBytes < 80 * 1024 * 1024) {
      try {
        const zip = new JSZip()
        for (const p of pageBlobs) zip.file(p.name, p.buf)
        // 图片本身已压缩，ZIP 使用 STORE 避免二次压缩占用时间
        const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
        const zipName = `${base}_图片合集.zip`
        zipFile = await uploadResult('result', zipBuf, zipName)
      } catch (err) {
        console.warn('[pdfProcess] zip pack failed (ignored):', err)
      }
    }
    return { files: outputs, zipFile }
  } finally {
    if (document) document.destroy()
  }
}

/** 把多个云端图片文件打包为一个 ZIP（供旧记录/未预打包的多图结果按需下载） */
async function makeZip(fileIDs, options, inputName) {
  const MAX_FILES = 50
  const MAX_BYTES = 80 * 1024 * 1024
  const names = (options && options.names) || []
  if (!Array.isArray(fileIDs) || fileIDs.length < 2) {
    throw new Error('至少需要 2 个文件才能打包压缩包')
  }
  if (fileIDs.length > MAX_FILES) {
    throw new Error(`最多一次打包 ${MAX_FILES} 个文件，请分批处理`)
  }
  const zip = new JSZip()
  let total = 0
  for (let i = 0; i < fileIDs.length; i++) {
    const buf = await downloadFile(fileIDs[i])
    total += buf.length
    if (total > MAX_BYTES) {
      throw new Error('文件总大小过大（超过 80MB），暂不支持打包，请直接逐张保存到相册')
    }
    // 保留原始文件名（去掉路径分隔符）
    const raw = String((names && names[i]) || `file_${i + 1}`).replace(/^.*[\\/]/, '')
    zip.file(raw, Buffer.from(buf))
  }
  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  const base = String(inputName || 'document')
    .replace(/\.(zip|pdf)$/i, '')
    .replace(/_第\d+页.*$/, '')
  const item = await uploadResult('result', zipBuf, `${base}_图片合集.zip`)
  return item
}

/** 身份证、毕业证等证件图片排版为 A4 PDF */
async function idcardLayout(fileIDs, options, inputName) {
  const A4 = { width: 595.28, height: 841.89 }
  const sizes = {
    idcard: { width: 85.60, height: 54.00 },
    bankcard: { width: 85.60, height: 54.00 },
    passport: { width: 125.00, height: 88.00 },
    diploma: { width: 210.00, height: 297.00 },
    degree: { width: 210.00, height: 297.00 }
  }
  const size = sizes[options.certificateType] || sizes.idcard
  const mm = 2.83465
  const cardWidth = size.width * mm
  const cardHeight = size.height * mm
  const requestedGap = Math.max(0, Math.min(50, Number(options.gap) || 0)) * mm
  const largeCertificate = size.width >= 210 || size.height >= 297
  const horizontal = !largeCertificate && options.direction !== 'upDown'
  const columns = horizontal ? 2 : 1
  const rows = largeCertificate ? 1 : horizontal ? 1 : 2
  const pageCapacity = largeCertificate ? 1 : 2
  const maxGap = horizontal
    ? Math.max(0, A4.width - columns * cardWidth) / (columns - 1 || 1)
    : Math.max(0, A4.height - rows * cardHeight) / (rows - 1 || 1)
  const gap = Math.min(requestedGap, maxGap)
  const totalWidth = columns * cardWidth + (columns - 1) * gap
  const totalHeight = rows * cardHeight + (rows - 1) * gap
  const out = await PDFDocument.create()
  for (let start = 0; start < fileIDs.length; start += pageCapacity) {
    const page = out.addPage([A4.width, A4.height])
    const batch = fileIDs.slice(start, start + pageCapacity)
    for (let i = 0; i < batch.length; i++) {
      const buf = await downloadFile(batch[i])
      let image
      try {
        image = await out.embedJpg(buf)
      } catch (err) {
        try {
          image = await out.embedPng(buf)
        } catch (err2) {
          throw new Error(`第 ${start + i + 1} 张图片无法解析，请使用 JPG / PNG 格式`)
        }
      }
      const ratio = image.width / image.height
      let width = cardWidth
      let height = width / ratio
      if (height > cardHeight) {
        height = cardHeight
        width = height * ratio
      }
      const col = horizontal ? i % 2 : 0
      const row = horizontal ? 0 : i
      const x =
        (A4.width - totalWidth) / 2 +
        col * (cardWidth + gap) +
        (cardWidth - width) / 2
      const y =
        A4.height -
        (A4.height - totalHeight) / 2 -
        (row + 1) * cardHeight -
        row * gap +
        (cardHeight - height) / 2
      page.drawImage(image, { x, y, width, height })
    }
  }
  const base = String(inputName || '证件').replace(/\.[^.]+$/i, '')
  const item = await uploadPdf(out, 'result', `${base}_A4排版.pdf`)
  return [{ ...item, pageCount: out.getPageCount() }]
}

/** 证件照按一寸/二寸尺寸排版为带分割线的 A4 PDF */
async function photoLayout(fileIDs, options, inputName) {
  const A4 = { width: 595.28, height: 841.89 }
  const sizes = {
    oneInch: { width: 25, height: 35 },
    twoInch: { width: 35, height: 49 }
  }
  const size = sizes[options.photoSize] || sizes.oneInch
  const mm = 2.83465
  const photoWidth = size.width * mm
  const photoHeight = size.height * mm
  const requestedGap = Math.max(0, Math.min(10, Number(options.gap) || 0)) * mm
  const copies = Math.max(1, Math.min(20, Number(options.copies) || 8))
  const columns = Math.max(1, Math.floor((A4.width + requestedGap) / (photoWidth + requestedGap)))
  const rows = Math.max(1, Math.floor((A4.height + requestedGap) / (photoHeight + requestedGap)))
  const perPage = columns * rows
  const gap = requestedGap
  const totalWidth = columns * photoWidth + (columns - 1) * gap
  const totalHeight = rows * photoHeight + (rows - 1) * gap
  const out = await PDFDocument.create()
  let placed = 0

  for (const fileID of fileIDs) {
    const buf = await downloadFile(fileID)
    let image
    try {
      image = await out.embedJpg(buf)
    } catch (err) {
      image = await out.embedPng(buf)
    }
    for (let copy = 0; copy < copies; copy++) {
      if (placed % perPage === 0) out.addPage([A4.width, A4.height])
      const page = out.getPage(out.getPageCount() - 1)
      const index = placed % perPage
      const col = index % columns
      const row = Math.floor(index / columns)
      const x = (A4.width - totalWidth) / 2 + col * (photoWidth + gap)
      const y = A4.height - (A4.height - totalHeight) / 2 - (row + 1) * photoHeight - row * gap
      const ratio = image.width / image.height
      let width = photoWidth
      let height = width / ratio
      if (height > photoHeight) {
        height = photoHeight
        width = height * ratio
      }
      page.drawImage(image, {
        x: x + (photoWidth - width) / 2,
        y: y + (photoHeight - height) / 2,
        width,
        height
      })
      page.drawRectangle({
        x,
        y,
        width: photoWidth,
        height: photoHeight,
        borderColor: rgb(0.55, 0.55, 0.55),
        borderWidth: 0.6,
        opacity: 0.9
      })
      placed++
    }
  }

  const base = String(inputName || '证件照').replace(/\.[^.]+$/i, '')
  const item = await uploadPdf(out, 'result', `${base}_证件照排版.pdf`)
  return [{ ...item, pageCount: out.getPageCount() }]
}

/** 图片转 PDF */
async function img2pdf(fileIDs, options, inputName) {
  const out = await PDFDocument.create()
  const forceA4 = options.pageSize === 'a4v' || options.pageSize === 'a4h'
  for (const fileID of fileIDs) {
    const buf = await downloadFile(fileID)
    let image
    try {
      image = await out.embedJpg(buf)
    } catch (err) {
      try {
        image = await out.embedPng(buf)
      } catch (err2) {
        console.error('[pdfProcess] embed image error:', err2)
        throw new Error('存在无法解析的图片，请使用 JPG / PNG 格式')
      }
    }
    const ratio = image.width / image.height
    if (forceA4) {
      const isLandscape = options.pageSize === 'a4h'
      const a4 = { width: 595.28, height: 841.89 }
      const targetW = isLandscape ? a4.height : a4.width
      const targetH = isLandscape ? a4.width : a4.height
      let w = targetW
      let h = w / ratio
      if (h > targetH) {
        h = targetH
        w = h * ratio
      }
      out.addPage([targetW, targetH])
      const page = out.getPage(out.getPageCount() - 1)
      page.drawImage(image, { x: (targetW - w) / 2, y: (targetH - h) / 2, width: w, height: h })
    } else {
      let w = image.width
      let h = image.height
      if (w > 1440) {
        h = (h * 1440) / w
        w = 1440
      }
      out.addPage([w, h])
      const page = out.getPage(out.getPageCount() - 1)
      page.drawImage(image, { x: 0, y: 0, width: w, height: h })
    }
  }
  const base = String(inputName || '图片')
  const item = await uploadPdf(out, 'result', `${base}图片合集.pdf`)
  return [{ ...item, pageCount: out.getPageCount() }]
}

/**
 * 拍照扫描合成 PDF（拍照转 PDF 后端核心，全部基于 MuPDF 内核）
 * 输入：前端已完成的“美化后”图片（自动描边/透视矫正/去阴影为白底黑字），一张图合成一页 A4。
 * 约束：禁止用 pdf-lib/jspdf 生成（方案强制 MuPDF）；PDF 由 MuPDF 新建页面并精准写入图片。
 */
async function scan2pdf(fileIDs, options, inputName) {
  const MAX_PAGES = 30
  const MAX_IMAGE_BYTES = 15 * 1024 * 1024
  if (!Array.isArray(fileIDs) || !fileIDs.length) {
    throw new Error('请先拍摄或添加照片')
  }
  if (fileIDs.length > MAX_PAGES) {
    throw new Error(`单次最多合成 ${MAX_PAGES} 张照片，请分批生成`)
  }
  let mupdf
  try {
    mupdf = await import('mupdf')
  } catch (err) {
    console.error('[pdfProcess] mupdf import error:', err)
    throw new Error('PDF 生成引擎未安装，请重新部署云函数依赖')
  }

  const A4_W = 595.28 // A4 纵向（pt）
  const A4_H = 841.89
  const quality = Math.max(70, Math.min(95, parseInt(options.quality, 10) || 88))
  const doc = new mupdf.PDFDocument()
  try {
    let at = 0
    for (let i = 0; i < fileIDs.length; i++) {
      const raw = await downloadFile(fileIDs[i])
      if (raw.length > MAX_IMAGE_BYTES) {
        throw new Error(`第 ${i + 1} 张照片过大，请重新拍摄或压缩后再试`)
      }
      let imgBytes = raw
      // JPEG 输入：fz_image 保留 DCT 压缩流，PDF 体积≈原图；其他格式（PNG 等）先统一转 JPEG，
      // 避免裸 RGB 写入导致 PDF 体积暴增
      if (!(raw[0] === 0xff && raw[1] === 0xd8)) {
        let tmpImg = null
        let pm = null
        try {
          tmpImg = new mupdf.Image(new Uint8Array(raw))
          pm = tmpImg.toPixmap()
          imgBytes = Buffer.from(pm.asJPEG(quality))
        } catch (err) {
          console.error(`[pdfProcess] scan image decode error #${i + 1}:`, err)
          throw new Error(`第 ${i + 1} 张照片无法解析，请重新拍摄或更换后再试`)
        } finally {
          if (pm) pm.destroy()
          if (tmpImg) tmpImg.destroy()
        }
      }

      let image = null
      try {
        image = new mupdf.Image(new Uint8Array(imgBytes))
        const iw = image.getWidth()
        const ih = image.getHeight()
        if (!iw || !ih) throw new Error('empty image')
        const imgRef = doc.addImage(image) // 生成图片 XObject
        // 等比缩放并居中放入 A4 页面，不裁切内容
        const scale = Math.min(A4_W / iw, A4_H / ih)
        const dw = iw * scale
        const dh = ih * scale
        const x = (A4_W - dw) / 2
        const y = (A4_H - dh) / 2
        const resources = doc.newDictionary()
        const xobjects = doc.newDictionary()
        xobjects.put('Im0', imgRef)
        resources.put('XObject', xobjects)
        const contents = `q\n${dw} 0 0 ${dh} ${x} ${y} cm\n/Im0 Do\nQ\n`
        const pageObj = doc.addPage([0, 0, A4_W, A4_H], 0, resources, contents)
        doc.insertPage(at++, pageObj)
      } catch (err) {
        console.error(`[pdfProcess] scan embed error #${i + 1}:`, err)
        throw new Error(`第 ${i + 1} 张照片写入 PDF 失败，请重新拍摄或更换后再试`)
      } finally {
        if (image) image.destroy()
      }
    }
    if (!at) throw new Error('没有可合成的照片')
    const outBuf = doc.saveToBuffer('{}')
    const bytes = Buffer.from(outBuf.asUint8Array())
    outBuf.destroy()
    // 以首张照片名称为基础生成结果文件名
    const base = String(inputName || '扫描件')
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]/g, '')
    const item = await uploadResult('result', bytes, `${base}扫描件.pdf`)
    return [{ ...item, pageCount: at }]
  } finally {
    doc.destroy()
  }
}

// ============================================
// 后台任务（异步处理：提交即返回，定时 worker 消费）
// ============================================

const TASKS = 'tasks'
const MAX_ATTEMPTS = 3
/** 单用户同时最多允许的待处理（排队中/处理中）任务数，防止个别人刷任务挤占队列 */
const MAX_ACTIVE_TASKS_PER_USER = 3
/** worker 单次触发最多执行时长（避免超出云函数超时被杀） */
const WORKER_BUDGET_MS = 12000
/** running 任务超过该时长仍未完成视为崩溃，允许重新抢占（云函数最长执行一般不超几分钟，故取 3 分钟较稳妥） */
const STALE_LOCK_MS = 3 * 60 * 1000

function ok(data) {
  return { code: 0, message: 'success', data }
}

function fail(message) {
  return { code: -1, message: message || '请求失败', data: null }
}

/** 兼容不同版本 SDK 的 openid 取值（云函数内优先用 getWXContext，最可靠） */
function openidOf(context, event) {
  try {
    const wxContext = cloud.getWXContext()
    if (wxContext && wxContext.OPENID) return wxContext.OPENID
  } catch (err) {
    // 非微信调用场景（如定时触发）忽略，回退其它来源
  }
  const ctx = context || {}
  const ui = (event && event.userInfo) || {}
  return ctx.OPENID || ctx.openId || ui.openId || ui.openid || ''
}

/**
 * 读取任务 result 字段。
 * 注意：云数据库 update 会把嵌套对象转成 result.xxx 点路径写入，
 * 而文档初始 result 为 null，会报 “Cannot create field … in {result: null}”，
 * 因此云端写入 result 一律用 JSON 字符串，读取时再解析。
 */
function parseTaskResult(raw) {
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch (err) {
      return raw
    }
  }
  return raw
}

/** 自动创建集合（首次使用时；已存在会抛错，直接忽略） */
async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    console.log(`[pdfProcess] collection created: ${name}`)
  } catch (err) {
    // 已存在等场景忽略
  }
}

/** 判断是否“集合尚不存在”错误（不同版本 SDK 文案不一，做宽松匹配） */
function isMissingCollection(err) {
  if (!err) return false
  const msg = String(err.errMsg || err.message || '')
  const code = String(err.errCode || err.code || '')
  if (/DATABASE_COLLECTION_NOT_EXIST|NOT_FOUND|RESOURCE_NOT_FOUND/i.test(code)) return true
  const hasDbWord = /collection|table|\bdatabase\b|db\b/i.test(msg)
  const hasMissing = /not\s*(exist|found)|doesn'?t\s*exist|missing/i.test(msg)
  return hasDbWord && hasMissing
}

/** 查询/写入 tasks 时兼容“集合尚不存在”的首次场景 */
async function withCollection(fn) {
  try {
    return await fn()
  } catch (err) {
    if (isMissingCollection(err)) {
      await ensureCollection(TASKS)
      return fn()
    }
    throw err
  }
}

/** 源文件登记 24h 清理 */
async function registerCleanup(fileIDs) {
  for (const fileID of fileIDs) {
    try {
      await db.collection('files').add({ data: { fileID, createdAt: db.serverDate() } })
    } catch (err) {
      console.warn('[pdfProcess] register source error:', err)
    }
  }
}

/** 公共执行层：执行具体 PDF 动作，返回统一结果结构 */
async function runAction(action, fileIDs, options, inputName) {
  let outputs = []
  let zipFile = null
  switch (action) {
    case 'split':
      outputs = await split(fileIDs, options, inputName)
      break
    case 'merge':
      outputs = await merge(fileIDs, options, inputName)
      break
    case 'deletePages':
      outputs = await deletePages(fileIDs, options, inputName)
      break
    case 'rotatePages':
      outputs = await rotatePages(fileIDs, options, inputName)
      break
    case 'reorderPages':
      outputs = await reorderPages(fileIDs, options, inputName)
      break
    case 'addPageNumbers':
      outputs = await addPageNumbers(fileIDs, options, inputName)
      break
    case 'watermark':
      outputs = await watermark(fileIDs, options, inputName)
      break
    case 'encrypt':
      outputs = await encrypt(fileIDs, options, inputName)
      break
    case 'decrypt':
      outputs = await decrypt(fileIDs, options, inputName)
      break
    case 'compress':
      outputs = await compress(fileIDs, options, inputName)
      break
    case 'photoLayout':
      outputs = await photoLayout(fileIDs, options, inputName)
      break
    case 'img2pdf':
      outputs = await img2pdf(fileIDs, options, inputName)
      break
    case 'idcardLayout':
      outputs = await idcardLayout(fileIDs, options, inputName)
      break
    case 'scan2pdf':
      outputs = await scan2pdf(fileIDs, options, inputName)
      break
    case 'pdf2text':
      outputs = await pdf2text(fileIDs, options, inputName)
      break
    case 'pdf2image': {
      const res = await pdf2image(fileIDs, options, inputName)
      outputs = res.files
      zipFile = res.zipFile
      break
    }
    case 'makeZip': {
      const item = await makeZip(fileIDs, options, inputName)
      outputs = [{ fileID: item.fileID, name: item.name, size: item.size, pageCount: 0 }]
      break
    }
    default:
      throw new Error(`暂不支持的处理类型：${action}`)
  }

  const totalPages = outputs.reduce((sum, o) => sum + (o.pageCount || 0), 0)
  const first = outputs[0]
  const data = {
    outputName:
      outputs.length > 1 ? `${outputs.length} 个文件 · ${first.name}` : first.name,
    pageCount: totalPages,
    outputSize: outputs.reduce((sum, o) => sum + (o.size || 0), 0),
    fileID: first ? first.fileID : '',
    files: outputs.map((o) => ({
      fileID: o.fileID,
      name: o.name,
      size: o.size || 0,
      pageCount: o.pageCount
    }))
  }
  if (zipFile) {
    data.zipFile = { fileID: zipFile.fileID, name: zipFile.name, size: zipFile.size || 0 }
  }
  console.log(`[pdfProcess] ${action} done, outputs=${outputs.length}, pages=${totalPages}`)
  return data
}

/** 查询某用户当前处于排队中/处理中的任务数量（限制上限用） */
async function activeTaskCount(openid) {
  const res = await withCollection(async () =>
    db
      .collection(TASKS)
      .where({ _openid: openid, status: _.in(['queued', 'running']) })
      .count()
  )
  return res.total || 0
}

/** 查询当前排队额度（客户端提交前先查一次，避免无谓上传） */
async function queueQuota(context, event) {
  const openid = openidOf(context, event)
  const active = await activeTaskCount(openid)
  return { active, max: MAX_ACTIVE_TASKS_PER_USER }
}

// ============================================
// 次数配额（按微信 openid 云端独立计数）
// ============================================

/** 配额集合：_id = openid，跨天/跨周自动重置，与处理记录完全解耦 */
const QUOTAS = 'quotas'
/** 每日基础免费次数 */
const QUOTA_DAILY_FREE = 10
/** 单次广告奖励次数 */
const QUOTA_AD_BONUS = 2

function quotaDate(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 'YYYY-M-D' -> Date（本机时区零点） */
function quotaParseDate(str) {
  const parts = String(str || '')
    .split('-')
    .map((n) => parseInt(n, 10))
  if (parts.length < 3 || parts.some((n) => isNaN(n))) return null
  return new Date(parts[0], parts[1] - 1, parts[2])
}

/** 本周一零点时间戳 */
function quotaWeekStart(d = new Date()) {
  const x = new Date(d)
  const day = x.getDay() || 7
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - day + 1)
  return x.getTime()
}

/** 组装对外 / 回传前端的配额结构 */
function quotaFormat(doc) {
  const todayLimit = QUOTA_DAILY_FREE + (doc.bonusCount || 0)
  const count = doc.count || 0
  return {
    date: doc.date,
    todayCount: count,
    weekCount: doc.weekCount || 0,
    todayLimit,
    availableCount: Math.max(0, todayLimit - count),
    bonusCount: doc.bonusCount || 0
  }
}

/** 读取某用户配额文档；不存在返回 null（区分“文档不存在”与其它异常） */
async function quotaDoc(openid) {
  try {
    const res = await db.collection(QUOTAS).doc(openid).get()
    return res.data || null
  } catch (err) {
    const msg = String(err.errMsg || err.message || '')
    if (/not exist|not found|doesn'?t exist|isn'?t exist|DOCUMENT_NOT_EXIST/i.test(msg)) return null
    throw err
  }
}

/** 首次使用（或集合不存在）时创建配额文档 */
async function ensureQuotaDoc(openid) {
  await ensureCollection(QUOTAS)
  const today = quotaDate()
  try {
    const exist = await quotaDoc(openid)
    if (exist) return exist
  } catch (err) {
    // 集合创建后首次读取可能因未见文档而报错，忽略后直接写入
  }
  // 注意：.doc(id).set() 的 data 里不能再带 _id，否则报 -501007（文档 ID 由 doc(openid) 指定）
  const doc = { openid, date: today, count: 0, weekCount: 0, bonusCount: 0 }
  await db.collection(QUOTAS).doc(openid).set({ data: doc })
  return { _id: openid, ...doc }
}

/** 读取并规范化配额文档：跨天清零当日，跨周同时清零本周累计 */
async function loadQuota(openid) {
  let doc = await quotaDoc(openid)
  if (!doc) return ensureQuotaDoc(openid)
  const today = quotaDate()
  if (doc.date === today) return doc
  const prevWeek = quotaWeekStart(quotaParseDate(doc.date) || new Date())
  const sameWeek = prevWeek === quotaWeekStart(new Date())
  const next = {
    date: today,
    count: 0,
    weekCount: sameWeek ? doc.weekCount || 0 : 0,
    bonusCount: 0
  }
  await db.collection(QUOTAS).doc(openid).update({ data: next })
  return { ...doc, ...next }
}

/** 读取当前配额 */
async function getQuota(openid) {
  return quotaFormat(await loadQuota(openid))
}

/**
 * 原子消耗一次处理次数。
 * 先规范化文档，再通过条件更新（count < 今日上限）保证并发不超扣。
 * 返回 { ok, quota }
 */
async function consumeQuota(openid) {
  const doc = await loadQuota(openid)
  const todayLimit = QUOTA_DAILY_FREE + (doc.bonusCount || 0)
  const res = await db
    .collection(QUOTAS)
    .where({ _id: openid, count: _.lt(todayLimit) })
    .update({
      data: {
        count: _.inc(1),
        weekCount: _.inc(1),
        date: doc.date
      }
    })
  const updated = res && res.stats ? res.stats.updated : 0
  const quota = quotaFormat({
    ...doc,
    count: (doc.count || 0) + (updated === 1 ? 1 : 0),
    weekCount: (doc.weekCount || 0) + (updated === 1 ? 1 : 0)
  })
  return { ok: updated === 1, quota }
}

/** 增加广告奖励次数 */
async function addBonusQuota(openid, amount) {
  const inc = Number(amount) > 0 ? Number(amount) : QUOTA_AD_BONUS
  const doc = await loadQuota(openid)
  const next = { bonusCount: (doc.bonusCount || 0) + inc }
  await db.collection(QUOTAS).doc(openid).update({ data: next })
  return quotaFormat({ ...doc, ...next })
}

/** 提交任务：写入 tasks（queued）后立即返回 taskId */
async function submitTask(event, context) {
  const targetAction = String(event.targetAction || '')
  const fileIDs = Array.isArray(event.fileIDs) ? event.fileIDs : []
  const fileNames = Array.isArray(event.fileNames) ? event.fileNames : []
  const options = event.options || {}
  if (!targetAction) return fail('缺少处理类型')
  if (!fileIDs.length) return fail('请先上传待处理文件')

  const openid = openidOf(context, event)
  // 云端二次校验：同用户待处理任务已达上限则拒绝（前端提交前也会先查一次）
  const active = await activeTaskCount(openid)
  if (active >= MAX_ACTIVE_TASKS_PER_USER) {
    return fail(`同时处理的任务已达上限（${MAX_ACTIVE_TASKS_PER_USER} 个），请先等待现有任务完成后再提交`)
  }

  await registerCleanup(fileIDs)
  const doc = {
    _openid: openid,
    targetAction,
    fileIDs,
    fileNames,
    options,
    status: 'queued',
    error: '',
    attempts: 0,
    createdAt: db.serverDate(),
    startedAt: null,
    finishedAt: null,
    result: null
  }
  const res = await withCollection(() => db.collection(TASKS).add({ data: doc }))
  // 按 openid 云端独立计数：提交即消耗一次处理次数；已达今日上限则回滚任务
  const consumed = await consumeQuota(openid)
  if (!consumed.ok) {
    await db
      .collection(TASKS)
      .doc(res._id)
      .remove()
      .catch((err) => console.warn('[pdfProcess] rollback task error:', err))
    return fail('今日免费处理次数已用完，观看广告后可继续使用')
  }
  console.log(`[pdfProcess] task submitted: ${res._id}, action=${targetAction}`)
  return ok({ taskId: res._id, quota: consumed.quota })
}

/** 查询任务状态（仅返回自己提交的任务） */
async function taskStatus(event, context) {
  const openid = openidOf(context, event)
  const ids = Array.isArray(event.taskIds) ? event.taskIds : []
  if (!ids.length) return fail('缺少任务编号')
  const list = await withCollection(async () => {
    const res = await db
      .collection(TASKS)
      .where({ _openid: openid, _id: _.in(ids.slice(0, 20)) })
      .limit(50)
      .get()
    return res.data
  })
  return ok({
    tasks: list.map((t) => ({
      taskId: t._id,
      status: t.status,
      error: t.error || '',
      result: parseTaskResult(t.result),
      finishedAt: t.finishedAt ? new Date(t.finishedAt).getTime() : 0
    }))
  })
}

/** 抢占一个待处理任务（含崩溃遗留的 running），返回 null 表示没有 */
async function claimNextTask() {
  const now = Date.now()
  // 1) 优先处理排队中任务（先到先得）
  const queued = await tryClaim({ status: 'queued', sortKey: 'createdAt', stale: false }, now)
  if (queued) return queued
  // 2) 处理执行中但已“卡死”超过阈值的任务
  return tryClaim({ status: 'running', sortKey: 'startedAt', stale: true }, now)
}

async function tryClaim(cond, now) {
  const staleBefore = new Date(now - STALE_LOCK_MS)
  const where = { status: cond.status }
  if (cond.stale) where.startedAt = _.lt(staleBefore)
  const query = db.collection(TASKS).where(where).orderBy(cond.sortKey, 'asc').limit(1)
  const res = await withCollection(async () => query.get())
  const doc = res.data[0]
  if (!doc) return null

  // 原子抢占：仅当文档仍处于期望状态时才置为 running，避免并发触发重复执行
  const claimWhere = { _id: doc._id, status: cond.status }
  if (cond.stale) claimWhere.startedAt = _.lt(staleBefore)
  const upd = await db
    .collection(TASKS)
    .where(claimWhere)
    .update({
      data: {
        status: 'running',
        startedAt: new Date(now),
        attempts: (doc.attempts || 0) + 1,
        error: ''
      }
    })
  if (!upd || upd.stats.updated !== 1) return null
  return { ...doc, _docId: doc._id }
}

/** 移除任务配置中的 PDF 密码：任务执行完立即清除，避免在数据库中留存 */
function withoutPassword(options) {
  if (!options || typeof options !== 'object' || !('password' in options)) return null
  const cleaned = { ...options }
  delete cleaned.password
  return cleaned
}

/** 执行单个任务并回写结果 */
async function executeTask(task) {
  const docId = task._docId
  const inputName =
    Array.isArray(task.fileNames) && task.fileNames.length ? task.fileNames[0] : 'document.pdf'
  try {
    if ((task.attempts || 0) > MAX_ATTEMPTS) {
      throw new Error('处理多次超时未完成，请稍后在记录中重新提交')
    }
    const data = await runAction(task.targetAction, task.fileIDs || [], task.options || {}, inputName)
    // 嵌套对象转点路径写入会与初始 null 冲突，统一用 JSON 字符串保存
    const patch = {
      status: 'success',
      result: JSON.stringify(data),
      error: '',
      startedAt: null,
      finishedAt: db.serverDate()
    }
    const cleaned = withoutPassword(task.options)
    if (cleaned) patch.options = cleaned
    await db.collection(TASKS).doc(docId).update({ data: patch })
    console.log(`[pdfProcess] task done: ${docId}`)
    return true
  } catch (err) {
    console.error(`[pdfProcess] task failed: ${docId}`, err)
    const patch = {
      status: 'failed',
      error: String(err.message || '处理失败，请稍后重试'),
      startedAt: null,
      finishedAt: db.serverDate()
    }
    const cleaned = withoutPassword(task.options)
    if (cleaned) patch.options = cleaned
    await db
      .collection(TASKS)
      .doc(docId)
      .update({ data: patch })
      .catch((e) => console.error('[pdfProcess] mark task failed error:', e))
    return false
  }
}

/** 清理已完成/失败超过 3 天的任务记录（防止 tasks 集合无限增长） */
async function housekeepTasks() {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  try {
    await db.collection(TASKS).where({ finishedAt: _.lt(cutoff) }).remove()
  } catch (err) {
    console.warn('[pdfProcess] housekeep tasks error:', err)
  }
}

/** 定时触发器：循环消费排队任务，直到时间预算用尽 */
async function runWorker() {
  const started = Date.now()
  let processed = 0
  let failed = 0
  for (let i = 0; i < 30; i++) {
    if (Date.now() - started > WORKER_BUDGET_MS) break
    const task = await claimNextTask()
    if (!task) break
    if (await executeTask(task)) processed++
    else failed++
  }
  // 空闲时顺带清理过期任务记录
  if (!processed && !failed) await housekeepTasks()
  console.log(
    `[pdfProcess] worker done: processed=${processed}, failed=${failed}, cost=${Date.now() - started}ms`
  )
  return ok({ processed, failed })
}

// ============================================
// 入口
// ============================================
exports.main = async (event, context) => {
  // 定时触发器 → 后台任务 worker
  if (event && (event.Type === 'Timer' || event.TriggerName)) {
    return runWorker(context)
  }
  const action = event.action || ''
  try {
    if (action === 'login') {
      return ok({ loggedIn: true, loggedAt: Date.now() })
    }
    // 异步任务：提交 / 查状态
    if (action === 'submit') return await submitTask(event, context)
    if (action === 'taskStatus') return await taskStatus(event, context)
    if (action === 'queueQuota') return ok(await queueQuota(context, event))
    // 次数配额（按 openid 云端独立计数）
    if (action === 'getQuota') return ok(await getQuota(openidOf(context, event)))
    if (action === 'consumeQuota') {
      const r = await consumeQuota(openidOf(context, event))
      return r.ok ? ok(r.quota) : fail('今日免费处理次数已用完，观看广告后可继续使用')
    }
    if (action === 'addBonus') return ok(await addBonusQuota(openidOf(context, event), event.amount))
    // 客户端提交后立即唤醒后台 worker 处理（fire-and-forget），定时触发仅作兜底
    if (action === 'worker') return runWorker(context)

    // 同步直接执行（历史/临时打包 makeZip 等轻量场景；源文件清理由调用方登记）
    const fileIDs = Array.isArray(event.fileIDs) ? event.fileIDs : []
    const options = event.options || {}
    const inputName =
      Array.isArray(event.fileNames) && event.fileNames.length ? event.fileNames[0] : 'document.pdf'
    if (!fileIDs.length) {
      return fail('请先上传待处理文件')
    }
    const data = await runAction(action, fileIDs, options, inputName)
    return ok(data)
  } catch (err) {
    console.error(`[pdfProcess] ${action} error:`, err)
    return fail(err.message || '处理失败，请稍后重试')
  }
}
