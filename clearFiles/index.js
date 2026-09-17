/**
 * PDF小助手 Pro 云函数后端（clearFiles）
 * 本程序以 GNU AGPL-3.0 发布，完整条款见同目录 LICENSE，第三方组件声明见 NOTICE
 * 源码地址：https://github.com/JIAOMAX1/pdf-tools-backend
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const EXPIRE_MS = 24 * 60 * 60 * 1000
const BATCH = 100

// ============================================
// 定时任务：清理超过 24 小时的云存储文件
// 依赖集合 files：{ fileID, createdAt }
// ============================================
exports.main = async (event, context) => {
  const cutoff = new Date(Date.now() - EXPIRE_MS)
  let removed = 0
  let docs = 0
  try {
    for (;;) {
      const res = await db
        .collection('files')
        .where({ createdAt: _.lt(cutoff) })
        .limit(BATCH)
        .get()
      const rows = res.data
      if (!rows.length) break

      const fileIDs = rows.map((row) => row.fileID).filter(Boolean)
      if (fileIDs.length) {
        try {
          const delRes = await cloud.deleteFile({ fileList: fileIDs })
          removed += (delRes.fileList || []).filter((f) => f.status === 0).length
        } catch (err) {
          console.error('[clearFiles] delete storage error:', err)
        }
      }

      // 删除数据库登记记录
      const ids = rows.map((row) => row._id)
      for (let i = 0; i < ids.length; i += 20) {
        const chunk = ids.slice(i, i + 20)
        await db.collection('files').where({ _id: _.in(chunk) }).remove()
      }
      docs += rows.length
      if (rows.length < BATCH) break
    }
    console.log(`[clearFiles] done, removed storage=${removed}, docs=${docs}`)
    return { code: 0, message: 'success', data: { removed, docs } }
  } catch (err) {
    console.error('[clearFiles] error:', err)
    return { code: -1, message: err.message || '清理失败', data: null }
  }
}
