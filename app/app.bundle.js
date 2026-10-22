
/* utils.js */
const DB_NAME = 'maintenance-workbench'
const DB_VERSION = 1
const APP_SCHEMA_VERSION = 9
const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]
const uid = (prefix) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`
const pad = (value) => String(value).padStart(2, '0')
const now = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const today = () => now().slice(0, 10)
const esc = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

function toast(message) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  document.body.append(el)
  setTimeout(() => el.remove(), 1700)
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function createImagePreview(source, maxDimension = 560) {
  const sourceUrl = typeof source === 'string' ? source : URL.createObjectURL(source)
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image()
      element.decoding = 'async'
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('无法生成照片缩略图'))
      element.src = sourceUrl
    })
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d', { alpha: false })
    context.fillStyle = '#0F1115'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const preview = canvas.toDataURL('image/jpeg', 0.72)
    canvas.width = 1
    canvas.height = 1
    return preview
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(sourceUrl)
  }
}

async function readFile(file) {
  const original = file?.dataUrl || await readFileAsDataURL(file)
  let preview = original
  try {
    preview = await createImagePreview(file?.dataUrl || file)
  } catch (error) {
    console.warn('Preview generation failed; keeping original photo', error)
  }
  return {
    original,
    preview,
    mime: file?.type || String(original).slice(5, String(original).indexOf(';')) || 'image/jpeg',
    name: file?.name || '照片',
    createdAt: now()
  }
}

function statusClass(status = '') {
  if (['紧急', '高'].includes(status)) return 'red'
  if (['进行中', '观察中', '评估中', '实施中', '验证中'].includes(status)) return 'warn'
  if (['已完成', '已解决'].includes(status)) return ''
  return 'blue'
}


/* store.js */

const app = {
  db: null,
  state: null,
  images: new Map(),
  gallerySets: new Map(),
  nativeSelections: new Map(),
  nativePhotoRequests: new Map(),
  nativePhotoChunks: new Map(),
  page: 'home',
  context: {},
  pendingPhoto: null
}

const DEFAULT_WORKSHOPS = ['1车间', '2车间', '3车间', '4车间', '其他设备']
const NORMAL_CATEGORIES = [
  { value: 'plc', label: 'PLC', aliases: ['plc'] },
  { value: 'hmi', label: 'HMI', aliases: ['hmi'] },
  { value: 'parameter', label: '参数', aliases: ['parameter', 'parameters', '参数'] },
  { value: 'temperature', label: '温度', aliases: ['temperature', 'temp', '温度'] },
  { value: 'pressure', label: '压力', aliases: ['pressure', '压力'] },
  { value: 'wiring', label: '接线', aliases: ['wiring', 'wire', '接线'] },
  { value: 'mechanical', label: '机械位置', aliases: ['mechanical', 'position', '机械位置'] },
  { value: 'other', label: '其他', aliases: ['other', '其它', '其他', ''] }
]

const ELECTRICAL_TYPES = [
  { value: 'note', label: '学习笔记' },
  { value: 'procedure', label: '操作卡' },
  { value: 'troubleshooting', label: '排故卡' },
  { value: 'wiring', label: '接线/图纸' }
]

const ELECTRICAL_CATEGORIES = ['安全与规范', '基础电工', '控制回路', '电机与驱动', 'PLC/HMI', '传感器与执行器', '配电与保护', '测量与工具', '其他']

function electricalTypeLabel(value) {
  return ELECTRICAL_TYPES.find((item) => item.value === value)?.label || '学习笔记'
}

function normalCategoryKey(value) {
  const source = String(value ?? '').trim().toLowerCase()
  return NORMAL_CATEGORIES.find((item) => item.value === source || item.aliases.some((alias) => alias.toLowerCase() === source))?.value || 'other'
}

function normalCategoryLabel(value) {
  const key = normalCategoryKey(value)
  return NORMAL_CATEGORIES.find((item) => item.value === key)?.label || '其他'
}

function normalizePhotos(record) {
  const legacy = Array.isArray(record.photos) && record.photos.length
    ? record.photos
    : Array.isArray(record.images)
      ? record.images
      : record.photos || record.imageId || record.image || record.uri
        ? [record.photos || record.imageId || record.image || record.uri]
        : []
  record.photos = legacy.map((photo, index) => {
    if (typeof photo === 'string') return { id: uid('photo'), imageId: photo, title: '', note: '', sortOrder: index, createdAt: record.createdAt || now() }
    const imageId = photo?.imageId || photo?.uri || photo?.path || photo?.url || photo?.src || ''
    return { ...photo, id: photo?.id || uid('photo'), imageId, sortOrder: Number.isFinite(photo?.sortOrder) ? photo.sortOrder : index, createdAt: photo?.createdAt || record.createdAt || now() }
  }).filter((photo) => photo.imageId).sort((a, b) => a.sortOrder - b.sortOrder)
}

function initialState() {
  return {
    version: APP_SCHEMA_VERSION,
    settings: { theme: 'dark', fontSize: '标准', compression: '标准', autoClearCache: false, cameraQuality: '高清', cloud: { endpoint: '', token: '', lastSyncAt: '' } },
    profile: { id: '', name: '维修工程师', phone: '', email: '', avatarImageId: '' },
    team: { id: '', name: '', password: '', ownerId: '', currentMemberId: '', members: [], joinStatus: '未加入' },
    shareRequests: [],
    workshops: DEFAULT_WORKSHOPS.map((name, index) => ({ id: `workshop-${index + 1}`, name, coverImageId: '', devices: [] })),
    normalRecords: [],
    faults: [],
    flows: [],
    principles: [],
    improvements: [],
    passwords: [],
    criticalParameters: [],
    electricalKnowledge: [],
    tasks: [],
    meetings: []
  }
}

function normalize(raw) {
  const base = initialState()
  const s = raw && typeof raw === 'object' ? raw : base
  s.version = APP_SCHEMA_VERSION
  for (const key of ['normalRecords', 'faults', 'flows', 'principles', 'improvements', 'passwords', 'criticalParameters', 'electricalKnowledge', 'tasks', 'meetings']) {
    s[key] = Array.isArray(s[key]) ? s[key] : []
  }
  s.settings = { ...base.settings, ...(s.settings || {}) }
  s.profile = { ...base.profile, ...(s.profile || {}) }
  s.profile.id = s.profile.id || uid('user')
  s.team = { ...base.team, ...(s.team || {}) }
  s.team.members = Array.isArray(s.team.members) ? s.team.members : []
  const isLegacyDefaultTeam = !s.team.ownerId && s.team.name === '维修工作台团队' && s.team.members.length === 1 && s.team.members[0]?.name === '管理员'
  if (isLegacyDefaultTeam) {
    s.team = { ...base.team }
  } else {
    s.team.id = s.team.id || (s.team.name ? uid('team') : '')
    s.team.joinStatus = s.team.joinStatus || (s.team.name ? '已加入' : '未加入')
    s.team.members = s.team.members.map((m) => ({
      id: m.id || uid('member'),
      userId: m.userId || '',
      name: m.name || '团队成员',
      role: normalizeTeamRole(m.role),
      joinedAt: m.joinedAt || now()
    }))
    if (s.team.name && !s.team.currentMemberId) {
      const mine = s.team.members.find((m) => m.userId === s.profile.id) || s.team.members.find((m) => m.name === s.profile.name)
      s.team.currentMemberId = mine?.id || ''
    }
    if (s.team.name && !s.team.ownerId && s.team.members.length) {
      s.team.ownerId = s.team.currentMemberId || s.team.members[0].id
      const owner = s.team.members.find((m) => m.id === s.team.ownerId)
      if (owner) owner.role = '创建者'
    }
  }
  s.shareRequests = Array.isArray(s.shareRequests) ? s.shareRequests : []
  s.workshops = Array.isArray(s.workshops) && s.workshops.length ? s.workshops : base.workshops

  s.workshops.forEach((w) => {
    w.id = w.id || uid('workshop')
    w.name = w.name || '未命名车间'
    w.coverImageId = w.coverImageId || ''
    w.devices = Array.isArray(w.devices) ? w.devices : []
    w.devices.forEach((d) => {
      d.id = d.id || uid('device')
      d.name = d.name || '未命名设备'
      d.code = d.code || d.model || ''
      d.owner = d.owner || ''
      d.location = d.location || ''
      d.coverImageId = d.coverImageId || ''
      d.createdAt = d.createdAt || now()
      d.updatedAt = d.updatedAt || d.createdAt
      normalizePhotos(d)
    })
  })

  const legacyLogs = Array.isArray(s.logs) ? s.logs : []
  legacyLogs.forEach((log) => {
    if (!s.faults.some((item) => item.id === log.id)) {
      s.faults.push({
        id: log.id || uid('fault'),
        title: log.title || '旧版故障记录',
        workshop: log.workshop || '',
        device: log.device || '',
        level: log.level === 'major' ? '高' : '中',
        symptom: log.description || '',
        cause: '',
        process: '',
        result: log.result || '',
        status: log.status || '观察中',
        shareStatus: log.shareStatus || '未分享',
        photos: log.photos || [],
        author: log.author || '',
        createdAt: log.createdAt || now(),
        updatedAt: log.updatedAt || log.createdAt || now()
      })
    }
  })

  s.normalRecords.forEach((r) => {
    normalizeRecord(r, '', true)
    r.categoryKey = normalCategoryKey(r.categoryKey || r.category)
  })
  s.faults.forEach((r) => normalizeRecord(r, '故障案例'))
  s.faults.forEach((r) => {
    r.shareStatus = r.shareStatus || '未分享'
    r.shareRequestedBy = r.shareRequestedBy || ''
    r.shareReviewedBy = r.shareReviewedBy || ''
  })
  s.flows.forEach((r) => {
    normalizeRecord(r, '拆装流程')
    r.steps = Array.isArray(r.steps) ? r.steps : []
    r.steps.forEach((step, index) => {
      step.id = step.id || uid('step')
      step.title = step.title || `第${index + 1}步`
      step.note = step.note || step.description || ''
      normalizePhotos(step)
    })
  })
  s.principles.forEach((r) => normalizeRecord(r, '设备原理'))
  s.improvements.forEach((r) => normalizeRecord(r, '改善记录'))
  s.passwords.forEach((r) => normalizeRecord(r, '密码库'))
  s.criticalParameters.forEach((r) => normalizeRecord(r, '关键参数'))
  s.electricalKnowledge.forEach((r) => {
    normalizeRecord(r, '电工知识')
    r.type = ELECTRICAL_TYPES.some((item) => item.value === r.type) ? r.type : 'note'
    r.category = String(r.category || '其他').trim() || '其他'
    r.content = r.content || ''
    r.keyPoints = r.keyPoints || ''
    r.tags = Array.isArray(r.tags) ? r.tags : String(r.tags || '').split(/[，,]/).map((item) => item.trim()).filter(Boolean)
    r.isPinned = Boolean(r.isPinned)
    r.steps = Array.isArray(r.steps) ? r.steps.map((step, index) => ({
      id: step?.id || uid('electrical-step'),
      title: step?.title || `第${index + 1}步`,
      note: step?.note || step?.description || '',
      done: Boolean(step?.done)
    })) : []
  })
  s.tasks.forEach((r) => normalizeRecord(r, '任务'))
  s.meetings.forEach((r) => normalizeRecord(r, '会议'))
  return s
}

function normalizeRecord(record, fallbackTitle, allowBlankTitle = false) {
  record.id = record.id || uid('record')
  record.title = allowBlankTitle ? (record.title || '') : (record.title || fallbackTitle)
  record.workshopId = record.workshopId || ''
  record.deviceId = record.deviceId || ''
  record.workshop = record.workshop || ''
  record.device = record.device || ''
  normalizePhotos(record)
  record.createdAt = record.createdAt || now()
  record.updatedAt = record.updatedAt || record.createdAt
}

function normalizeTeamRole(role) {
  if (role === '创建者' || role === '管理员') return role
  return '成员'
}

function currentMember() {
  const t = app.state?.team
  if (!t?.members?.length) return null
  return t.members.find((m) => m.id === t.currentMemberId) || t.members.find((m) => m.userId === app.state.profile.id) || null
}

function isTeamJoined() {
  return app.state?.team?.joinStatus === '已加入' && !!currentMember()
}

function isTeamOwner() {
  const member = currentMember()
  return !!member && (member.role === '创建者' || member.id === app.state.team.ownerId)
}

function isTeamAdmin() {
  const member = currentMember()
  return !!member && ['创建者', '管理员'].includes(member.role)
}

function canEditSharedRecord(record) {
  if (!record || record.shareStatus !== '已分享') return true
  return isTeamAdmin() || record.createdById === app.state.profile.id
}

async function bootStore() {
  app.db = await openDb()
  app.images = await dbAllImages()
  app.state = normalize(await dbGet('app', 'state'))
  applySettings()
  await saveState()
}

async function upgradeLegacyImagePreviews() {
  const legacy = [...app.images.entries()].filter(([, value]) => typeof value === 'string' && value.startsWith('data:image/'))
  for (const [imageId, original] of legacy) {
    try {
      const preview = await createImagePreview(original)
      const asset = { original, preview, mime: original.slice(5, original.indexOf(';')) || 'image/jpeg', name: '旧版照片', createdAt: now() }
      app.images.set(imageId, asset)
      await dbPut('images', imageId, asset)
    } catch (error) {
      console.warn('Legacy photo preview upgrade skipped', imageId, error)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function applySettings() {
  document.body.classList.toggle('light-mode', app.state?.settings?.theme === 'light')
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('app')) db.createObjectStore('app')
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function dbGet(store, key) {
  return new Promise((resolve, reject) => {
    const request = app.db.transaction(store).objectStore(store).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function dbPut(store, key, value) {
  return new Promise((resolve, reject) => {
    const request = app.db.transaction(store, 'readwrite').objectStore(store).put(value, key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const request = app.db.transaction(store, 'readwrite').objectStore(store).delete(key)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function dbAllImages() {
  return new Promise((resolve, reject) => {
    const result = new Map()
    const request = app.db.transaction('images').objectStore('images').openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return resolve(result)
      result.set(cursor.key, cursor.value)
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
}

const saveState = () => dbPut('app', 'state', app.state)
const imageAsset = (id) => app.images.get(id)
const img = (id) => {
  if (!id) return ''
  const stored = imageAsset(id)
  if (stored) return typeof stored === 'string' ? stored : (stored.preview || stored.original || '')
  if (/^(https?:|data:|blob:|file:|cloud:\/\/|wxfile:\/\/)/.test(id)) return id
  return ''
}
const imgOriginal = (id) => {
  if (!id) return ''
  const stored = imageAsset(id)
  if (stored) return typeof stored === 'string' ? stored : (stored.original || stored.preview || '')
  return img(id)
}

function previewImageTag(imageId, alt = '照片', className = '') {
  const src = img(imageId)
  if (!src) return ''
  const galleryId = registerGallery([{ imageId, title: alt }], alt)
  return `<img class="${esc(className)}" src="${src}" alt="${esc(alt)}" loading="lazy" decoding="async" draggable="false" data-action="preview-gallery" data-gallery-id="${galleryId}" data-gallery-index="0">`
}

function registerGallery(photos = [], title = '照片预览') {
  const galleryId = uid('gallery')
  const items = photos.map((photo) => ({ imageId: photo.imageId, src: imgOriginal(photo.imageId), title: photo.title || title })).filter((photo) => photo.src)
  app.gallerySets.set(galleryId, items)
  return galleryId
}

function galleryImageTags(photos = [], title = '照片预览', limit = 0, context = {}) {
  const ordered = [...photos].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  const galleryId = registerGallery(ordered, title)
  const visible = limit ? ordered.slice(0, limit) : ordered
  return visible.map((photo, index) => {
    const src = img(photo.imageId)
    if (!src) return `<div class="image-failed">照片加载失败</div>`
    const more = limit && index === visible.length - 1 && ordered.length > visible.length ? `<span class="photo-more">+${ordered.length - visible.length}</span>` : ''
    const hold = context.kind && context.recordId ? ` data-hold-photo="true" data-kind="${esc(context.kind)}" data-record-id="${esc(context.recordId)}" data-photo-id="${esc(photo.id || '')}" data-image-id="${esc(photo.imageId || '')}"` : ''
    return `<span class="gallery-thumb"${hold}>${`<img src="${src}" alt="${esc(photo.title || title)}" loading="lazy" decoding="async" draggable="false" data-action="preview-gallery" data-gallery-id="${galleryId}" data-gallery-index="${index}">`}${more}</span>`
  }).join('')
}

function photoPicker(id = 'files', multiple = false, label = '拍照或从相册选择') {
  return `<label class="photo-picker"><input id="${esc(id)}" type="file" accept="image/*" ${multiple ? 'multiple' : ''}><span class="photo-picker-icon" aria-hidden="true">◉</span><span><b>${esc(label)}</b><small>${multiple ? '支持多选，选中后可预览' : '可以现场拍照，也可选择已有照片'}</small></span><i>›</i></label>`
}

function bindSimplePendingPreview(inputId = 'files', panelId = 'pending-photo-preview') {
  const input = $(`#${inputId}`)
  const panel = $(`#${panelId}`)
  if (!input || !panel) return
  let objectUrls = []
  const paint = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url))
    objectUrls = selectedFiles(inputId).map((file) => file.dataUrl || URL.createObjectURL(file))
    panel.innerHTML = objectUrls.length
      ? `<p class="muted">已选择 ${objectUrls.length} 张，保存后会完整写入本机图库。</p><div class="editable-photo-grid pending">${objectUrls.map((src, index) => `<figure><img src="${src}" alt="待保存照片 ${index + 1}" draggable="false"><figcaption>新增 ${index + 1}</figcaption></figure>`).join('')}</div>`
      : ''
  }
  input.addEventListener('change', paint)
}

function showImagePreview(imageId, title = '照片预览') {
  const src = imgOriginal(imageId)
  if (!src) return toast('照片数据不存在，请重新添加或从备份恢复')
  window.WorkbenchUI?.openGallery([{ imageId, src, title }], 0, title)
}
const workshops = () => app.state.workshops
const workshopById = (id) => workshops().find((w) => w.id === id)
const deviceById = (workshopId, deviceId) => workshopById(workshopId)?.devices.find((d) => d.id === deviceId)
const allDevices = () => workshops().flatMap((workshop) => workshop.devices.map((device) => ({ workshop, device })))
const findDeviceInfo = (deviceId) => allDevices().find(({ device }) => device.id === deviceId)

async function storeFiles(files) {
  const result = []
  const failed = []
  const list = [...files]
  if (!list.length) return result
  showImportProgress(list.length)
  for (let index = 0; index < list.length; index += 1) {
    const file = list[index]
    updateImportProgress(index, list.length, file.name || `照片${index + 1}`)
    let stage = '读取原图'
    try {
      const imageId = uid('image')
      const asset = await readFile(file)
      stage = '写入本地图库'
      await dbPut('images', imageId, asset)
      app.images.set(imageId, asset)
      result.push({ id: uid('photo'), imageId, title: file.name || '照片', note: '', sortOrder: result.length, createdAt: now() })
    } catch (error) {
      console.error('Photo import failed', error)
      failed.push({ name: file.name || `照片${index + 1}`, stage, reason: error?.message || String(error) })
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  hideImportProgress()
  app.lastPhotoImportError = failed[0] || null
  if (failed.length) toast(`照片在“${failed[0].stage}”时失败：${failed[0].reason || '未知原因'}`)
  else if (list.length > 1) toast(`已导入 ${result.length} 张照片`)
  return result
}

function showImportProgress(total) {
  document.querySelector('.import-progress')?.remove()
  const panel = document.createElement('div')
  panel.className = 'import-progress'
  panel.innerHTML = `<strong>正在处理照片</strong><span>0 / ${total}</span><div><i></i></div><small>保留原图并生成快速预览，请不要退出应用</small>`
  document.body.append(panel)
}

function updateImportProgress(index, total, name) {
  const panel = document.querySelector('.import-progress')
  if (!panel) return
  panel.querySelector('span').textContent = `${index + 1} / ${total}`
  panel.querySelector('i').style.width = `${((index + 1) / total) * 100}%`
  panel.querySelector('small').textContent = name
}

function hideImportProgress() {
  document.querySelector('.import-progress')?.remove()
}

function selectedFiles(inputId = 'files') {
  const nativeFiles = app.nativeSelections.get(inputId)
  if (nativeFiles?.length) return [...nativeFiles]
  return [...($(`#${inputId}`)?.files || [])]
}

function clearSelectedFiles(inputId = 'files') {
  app.nativeSelections.delete(inputId)
  const input = $(`#${inputId}`)
  if (input) input.value = ''
}

function imageIsReferenced(imageId) {
  if (!imageId) return false
  if (app.state.profile?.avatarImageId === imageId) return true
  for (const workshop of workshops()) {
    if (workshop.coverImageId === imageId) return true
    for (const device of workshop.devices || []) {
      if (device.coverImageId === imageId) return true
      if ((device.photos || []).some((photo) => photo.imageId === imageId)) return true
    }
  }
  for (const kind of ['normalRecords', 'faults', 'flows', 'principles', 'improvements', 'passwords', 'criticalParameters', 'electricalKnowledge', 'tasks', 'meetings']) {
    for (const record of app.state[kind] || []) {
      if (record.coverImageId === imageId || (record.photos || []).some((photo) => photo.imageId === imageId)) return true
      if ((record.steps || []).some((step) => step.imageId === imageId || (step.photos || []).some((photo) => photo.imageId === imageId))) return true
    }
  }
  return false
}

async function deletePhotos(photos = []) {
  for (const photo of photos) {
    if (photo.imageId && !imageIsReferenced(photo.imageId)) {
      await dbDelete('images', photo.imageId)
      app.images.delete(photo.imageId)
    }
  }
}

function deviceName(deviceId) {
  return findDeviceInfo(deviceId)?.device.name || '未指定设备'
}

function workshopName(workshopId) {
  return workshopById(workshopId)?.name || '未指定车间'
}

function touchUpdated(record) {
  record.updatedAt = now()
}


/* modal.js */

function closeModal() {
  $('#modal-root').innerHTML = ''
  clearSelectedFiles('files')
  clearSelectedFiles('avatar')
}

function showModal(html, options = {}) {
  const dismiss = options.dismissible === false ? '' : 'data-action="close-modal"'
  $('#modal-root').innerHTML = `
    <div class="modal-mask" ${dismiss}>
      <section class="modal ${options.center ? 'center' : ''}" data-stop>${html}</section>
    </div>
  `
}

function confirmDialog(title, text, onConfirm, options = {}) {
  showModal(`
    <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="muted">${esc(text)}</p>
    <div class="modal-actions">
      <button class="btn secondary" data-action="close-modal">取消</button>
      <button class="btn ${options.danger === false ? '' : 'danger'}" id="confirm-action">${esc(options.label || '确认')}</button>
    </div>
  `, { center: true })
  $('#confirm-action').onclick = async () => {
    await onConfirm()
    closeModal()
  }
}


/* render.js */

const icons = {
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8.5h3.2l1.4-2.2h6.8l1.4 2.2H20v10H4z"/><circle cx="12" cy="13.5" r="3.2"/></svg>',
  flow: '<svg viewBox="0 0 24 24"><path d="M7 6h10M7 12h6M7 18h10"/><path d="M17 6l2 2-2 2M13 12l2 2-2 2M17 18l2 2-2 2"/></svg>',
  improve: '<svg viewBox="0 0 24 24"><path d="M4 17l6-6 4 4 6-8"/><path d="M15 7h5v5"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  workshop: '<svg viewBox="0 0 24 24"><path d="M3 19V9l5 3V9l5 3V7h8v12z"/><path d="M7 19v-4h4v4M15 19v-4h3"/></svg>',
  normal: '<svg viewBox="0 0 24 24"><path d="M4 12h4l2-5 4 10 2-5h4"/><path d="M5 20h14"/></svg>',
  fault: '<svg viewBox="0 0 24 24"><path d="M12 3l9 16H3z"/><path d="M12 9v4M12 17h.01"/></svg>',
  principle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8"/></svg>',
  parameter: '<svg viewBox="0 0 24 24"><path d="M4 18V6M4 18h16"/><path d="M7 15l4-5 3 2 5-7"/><circle cx="7" cy="15" r="1"/><circle cx="11" cy="10" r="1"/><circle cx="14" cy="12" r="1"/><circle cx="19" cy="5" r="1"/></svg>',
  electrical: '<svg viewBox="0 0 24 24"><path d="M7 3h10v6l-3 3v9H10v-9L7 9z"/><path d="M12 6v3M9 16h6"/><circle cx="12" cy="6" r="1"/></svg>'
}

function icon(name) {
  return icons[name] || icons.workshop
}

function render() {
  app.gallerySets.clear()
  document.body.classList.toggle('home-page', app.page === 'home')
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === app.page))
  const pages = {
    home: renderHome,
    workshops: renderWorkshops,
    workshop: renderWorkshop,
    device: renderDevice,
    module: renderModule,
    logs: renderLogs,
    electrical: renderElectricalKnowledge,
    flows: renderFlows,
    team: renderTeam,
    me: renderMe
  }
  document.querySelector('#app').innerHTML = (pages[app.page] || renderHome)()
  bindHoldClass()
}

function empty(text, sub = '记录会保存在本机，后续可以导出备份。') {
  return `<section class="empty card"><h3>${esc(text)}</h3><p>${esc(sub)}</p></section>`
}

const knowledgeMeta = {
  normalRecords: { label: '正常状态', className: '' },
  faults: { label: '故障案例', className: 'red' },
  flows: { label: '拆装流程', className: 'warn' },
  principles: { label: '设备原理', className: 'blue' },
  improvements: { label: '改善记录', className: 'warn' },
  criticalParameters: { label: '关键参数', className: 'blue' },
  electricalKnowledge: { label: '电工知识', className: 'blue' }
}

function knowledgeItems(deviceId = '') {
  return Object.entries(knowledgeMeta).flatMap(([kind, meta]) => app.state[kind]
    .filter((item) => !deviceId || item.deviceId === deviceId)
    .map((item) => ({ ...item, kind, meta })))
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
}

function recordDisplayTitle(item, kind = '') {
  if (kind === 'normalRecords' || item?.kind === 'normalRecords') return `${deviceNameSafe(item.deviceId)} · ${normalCategoryLabel(item.categoryKey || item.category)}`
  return item?.title || '记录'
}

function electricalProgress(item) {
  const steps = item.steps || []
  const done = steps.filter((step) => step.done).length
  return { done, total: steps.length, percent: steps.length ? Math.round((done / steps.length) * 100) : 0 }
}

function electricalCategoryOptions(selected = '') {
  const categories = [...new Set([...ELECTRICAL_CATEGORIES, ...app.state.electricalKnowledge.map((item) => item.category).filter(Boolean), selected])]
  return categories.map((category) => `<option value="${esc(category)}"></option>`).join('')
}

function renderElectricalKnowledge() {
  const keyword = app.context.electricalKeyword || ''
  const type = app.context.electricalType || 'all'
  const category = app.context.electricalCategory || 'all'
  let items = [...app.state.electricalKnowledge]
  if (type !== 'all') items = items.filter((item) => item.type === type)
  if (category !== 'all') items = items.filter((item) => item.category === category)
  if (keyword) {
    const term = keyword.toLowerCase()
    items = items.filter((item) => [item.title, item.category, item.content, item.keyPoints, ...(item.tags || []), ...(item.steps || []).flatMap((step) => [step.title, step.note])].join(' ').toLowerCase().includes(term))
  }
  items.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
  const categories = [...new Set([...ELECTRICAL_CATEGORIES, ...app.state.electricalKnowledge.map((item) => item.category).filter(Boolean)])]
  return `
    <main class="page">
      <header class="topbar"><div><h1>电工知识</h1><p>把学习内容沉淀成现场可执行的知识卡。</p></div><button class="btn small" data-action="edit-electrical">+ 新增</button></header>
      <div class="search-box inline"><span>⌕</span><input id="electrical-search" value="${esc(keyword)}" placeholder="搜索原理、回路、故障、步骤..." autocomplete="off"></div>
      <section class="electrical-safety"><span class="electrical-safety-mark">ϟ</span><div><b>操作前安全核对</b><p>按现场规程完成断电、验电、放电、挂牌和复核。本页用于记录经验，不替代现场安全制度。</p></div></section>
      <div class="filter-row">${[{ value: 'all', label: '全部' }, ...ELECTRICAL_TYPES].map((item) => `<button class="chip ${type === item.value ? 'active' : ''}" data-action="electrical-type-filter" data-filter="${item.value}">${item.label}</button>`).join('')}</div>
      <p class="electrical-filter-label">知识分类</p>
      <div class="filter-row">${[{ value: 'all', label: '全部' }, ...categories.map((value) => ({ value, label: value }))].map((item) => `<button class="chip ${category === item.value ? 'active' : ''}" data-action="electrical-category-filter" data-filter="${esc(item.value)}">${esc(item.label)}</button>`).join('')}</div>
      ${items.length ? `<section class="grid-list">${items.map(electricalKnowledgeCard).join('')}</section>` : empty(keyword ? '没有找到相关电工知识' : '还没有电工知识记录', '新增学习笔记、操作卡、排故卡或接线资料，之后可随时搜索和按步骤执行。')}
    </main>
  `
}

function electricalKnowledgeCard(item) {
  const progress = electricalProgress(item)
  const summary = item.keyPoints || item.content || (item.steps?.[0]?.note || '') || '点击查看完整内容'
  const typeLabel = electricalTypeLabel(item.type)
  return `<article class="record-card electrical-card card hold-edit-card" data-action="view-record" data-kind="electricalKnowledge" data-id="${item.id}">
    <div class="card-head"><span class="badge blue">${esc(typeLabel)}</span><span>${item.isPinned ? '<b class="electrical-pin">置顶</b>' : ''}</span></div>
    <h3>${esc(item.title)}</h3><p>${esc(summary)}</p>
    <div class="split"><span class="muted">${esc(item.category || '其他')}${item.tags?.length ? ` · ${esc(item.tags.slice(0, 2).join(' / '))}` : ''}</span><span class="muted">${esc((item.updatedAt || item.createdAt || '').slice(0, 10))}</span></div>
    ${progress.total ? `<div class="electrical-progress"><i style="--progress:${progress.percent}%"></i><span>${progress.done}/${progress.total} 步</span></div>` : ''}
    ${item.photos?.length ? `<div class="preview-grid">${galleryImageTags(item.photos, item.title || '电工知识照片', 3, { kind: 'electricalKnowledge', recordId: item.id })}</div>` : ''}
    <div class="edit-mode-actions"><button class="edit-mode-action" data-action="edit-electrical" data-id="${item.id}">编辑</button><button class="edit-mode-action danger" data-action="delete-record" data-kind="electricalKnowledge" data-id="${item.id}">删除</button></div>
  </article>`
}

function knowledgeRow(item) {
  const description = item.kind === 'normalRecords' ? `${item.photos?.length || 0} 张照片` : (item.result || item.symptom || item.description || item.summary || item.plan || '点击查看完整记录')
  return `<div class="row knowledge-row" data-action="view-record" data-kind="${item.kind}" data-id="${item.id}">
    <span class="timeline-mark ${item.meta.className}"></span>
    <div class="row-main"><span class="row-title">${esc(recordDisplayTitle(item))}</span><span class="row-meta">${esc(description)} · ${esc((item.updatedAt || item.createdAt || '').slice(0, 10))}</span></div>
    <span class="badge ${item.meta.className}">${item.meta.label}</span>
  </div>`
}

function renderHome() {
  const tasks = app.state.tasks.filter((item) => item.status !== '已完成').slice(0, 4)
  const recent = allDevices().slice(-8).reverse()
  const meeting = [...app.state.meetings].reverse()[0]
  return `
    <main class="page">
      <section class="hero">
        <div class="hero-top">
          <button class="round notify" data-action="notice">⌕</button>
          <button class="round avatar" data-action="profile-settings">${avatarHtml()}</button>
        </div>
        <div class="hero-copy">
          <h1>维修工作台</h1>
          <h2>Maintenance Workbench</h2>
          <div class="marquee"><span>让经验沉淀，让维修更简单。Preserve Knowledge. Simplify Maintenance.</span></div>
        </div>
        <div class="search-box" data-action="search"><span>⌕</span><input readonly placeholder="搜索设备、故障、参数、原理、密码..."></div>
        <div class="quick-grid">
          <button class="quick-card" data-page="workshops"><b>${icon('camera')}</b>设备相册</button>
          <button class="quick-card orange" data-action="edit-flow"><b>${icon('flow')}</b>拆装流程</button>
          <button class="quick-card purple" data-action="edit-improvement"><b>${icon('improve')}</b>升级改造</button>
          <button class="quick-card blue" data-action="open-passwords"><b>${icon('lock')}</b>密码库</button>
        </div>
      </section>
      <div class="section-head"><h2>今日待办</h2><span data-action="open-tasks">查看全部</span></div>
      ${tasks.length ? `<section class="list card">${tasks.map(taskRow).join('')}</section>` : empty('今天没有待办', '可以从“工作日志”下方新建任务。')}
      <div class="section-head"><h2>最近访问设备</h2><span data-page="workshops">查看全部</span></div>
      ${recent.length ? `<section class="h-scroll">${recent.map(deviceMini).join('')}</section>` : empty('还没有设备', '进入“设备”新增车间和设备。')}
      <div class="section-head"><h2>今日会议</h2><span data-action="edit-meeting">新增</span></div>
      ${meeting ? `<section class="list card">${meetingRow(meeting)}</section>` : empty('还没有会议记录', '记录会议提醒、交接事项、维修复盘都可以。')}
    </main>
  `
}

function avatarHtml() {
  const src = img(app.state.profile.avatarImageId)
  return src ? `<img src="${src}" alt="">` : ''
}

function taskRow(task) {
  const cls = statusClass(task.status || task.priority)
  return `<div class="row" data-action="edit-task" data-id="${task.id}">
    <span class="dot ${cls === 'red' ? 'urgent' : cls === 'warn' ? 'doing' : 'info'}"></span>
    <div class="row-main"><span class="row-title">${esc(task.title)}</span><span class="row-meta">${esc(task.deadline || task.startDate || today())}</span></div>
    <span class="badge ${cls}">${esc(task.status || '待处理')}</span>
  </div>`
}

function meetingRow(meeting) {
  return `<div class="row" data-action="edit-meeting" data-id="${meeting.id}">
    <span class="badge blue">会议</span>
    <div class="row-main"><span class="row-title">${esc(meeting.title)}</span><span class="row-meta">${esc(meeting.time || meeting.date || meeting.createdAt)} · ${esc(meeting.place || '未填地点')}</span></div>
  </div>`
}

function deviceMini({ workshop, device }) {
  const cover = img(device.coverImageId || device.photos?.[0]?.imageId)
  return `<article class="device-mini card" data-action="open-device-any" data-workshop="${workshop.id}" data-device="${device.id}">
    ${cover ? `<img src="${cover}" alt="">` : `<div class="image-fallback">设备</div>`}
    <div><strong>${esc(device.name)}</strong><small>最近更新：${esc((device.updatedAt || device.createdAt || '').slice(0, 10) || '今天')}</small><small>${esc(workshop.name)}</small></div>
  </article>`
}

function renderWorkshops() {
  return `
    <main class="page">
      <header class="topbar">
        <div><h1>设备管理</h1><p>车间列表，可新增、编辑、删除。</p></div>
        <button class="btn small" data-action="edit-workshop">+ 新增车间</button>
      </header>
      <section class="grid-list">
        ${workshops().map((w) => `<article class="workshop-card card hold-edit-card" data-action="open-workshop" data-id="${w.id}">
          <div class="workshop-icon">${w.coverImageId ? `<img src="${img(w.coverImageId)}" alt="">` : icon('workshop')}</div>
          <div class="row-main"><span class="row-title">${esc(w.name)}</span><span class="row-meta">${w.devices.length} 台设备</span></div>
          <span class="chev">›</span>
          <div class="edit-mode-actions"><button class="edit-mode-action" data-action="edit-workshop" data-id="${w.id}">编辑</button><button class="edit-mode-action danger" data-action="delete-workshop" data-id="${w.id}">删除</button></div>
        </article>`).join('')}
      </section>
    </main>
  `
}

function renderWorkshop() {
  const w = workshopById(app.context.workshopId)
  if (!w) return empty('车间不存在')
  return `
    <main class="page">
      <header class="topbar">
        <button class="back" data-page="workshops">‹</button>
        <div class="row-main"><h1>${esc(w.name)}</h1><p>设备列表</p></div>
        <button class="btn small" data-action="edit-device">+ 新建设备</button>
      </header>
      <div class="search-box inline" data-action="search"><span>⌕</span><input readonly placeholder="搜索设备"></div>
      ${w.devices.length ? `<section class="grid-list">${w.devices.map((d) => deviceRow(w, d)).join('')}</section>` : empty('这个车间还没有设备')}
    </main>
  `
}

function deviceRow(w, d) {
  const cover = img(d.coverImageId || d.photos?.[0]?.imageId)
  const recordCount = countDeviceRecords(d.id)
  return `<article class="device-card card hold-edit-card" data-action="open-device" data-id="${d.id}">
    <div class="thumb">${cover ? `<img src="${cover}" alt="">` : ''}</div>
    <div class="row-main"><span class="row-title">${esc(d.name)}</span><span class="row-meta">${esc((d.updatedAt || '').slice(0,10) || '今天')} · ${recordCount} 条记录</span></div>
    <span class="chev">›</span>
    <div class="edit-mode-actions"><button class="edit-mode-action" data-action="edit-device" data-id="${d.id}">编辑</button><button class="edit-mode-action danger" data-action="delete-device" data-id="${d.id}">删除</button></div>
  </article>`
}

function countDeviceRecords(deviceId) {
  return ['normalRecords', 'faults', 'flows', 'principles', 'improvements', 'passwords', 'criticalParameters', 'electricalKnowledge'].reduce((sum, key) => sum + app.state[key].filter((item) => item.deviceId === deviceId).length, 0)
}

function renderDevice() {
  const w = workshopById(app.context.workshopId)
  const d = deviceById(app.context.workshopId, app.context.deviceId)
  if (!w || !d) return empty('设备不存在')
  return `
    <main class="page">
      <header class="topbar">
        <button class="back" data-action="back-workshop">‹</button>
        <div class="row-main"><h1>${esc(d.name)}</h1><p>${esc(w.name)}</p></div>
        <button class="more" data-action="device-menu" data-id="${d.id}">⋯</button>
      </header>
      <section class="card record-card">
        <div class="split"><span class="muted">所属车间：${esc(w.name)}</span><span class="muted">最近更新：${esc((d.updatedAt || '').slice(0,10) || '今天')}</span></div>
      </section>
      <section class="function-grid">
        ${moduleButton('normal', '正常状态', '正常照片和参数', icon('normal'))}
        ${moduleButton('faults', '故障案例', '问题、原因和结果', icon('fault'))}
        ${moduleButton('flows', '拆装流程', '拆卸和安装步骤', icon('flow'))}
        ${moduleButton('principles', '设备原理', '原理和经验传承', icon('principle'))}
        ${moduleButton('improvements', '改善记录', '升级改造全过程', icon('improve'))}
        ${moduleButton('passwords', '密码库', '默认隐藏显示', icon('lock'))}
        ${moduleButton('criticalParameters', '关键参数', '数值、部件和影响逻辑', icon('parameter'))}
      </section>
    </main>
  `
}

function moduleButton(module, title, sub, icon) {
  return `<button class="function-card" data-action="open-module" data-module="${module}"><b>${icon}</b>${title}<br><small>${sub}</small></button>`
}

function renderModule() {
  const module = app.context.module
  const conf = moduleConfig(module)
  const items = getModuleItems(module)
  const limit = module === 'normal' ? (app.context.normalLimit || 24) : items.length
  const visibleItems = items.slice(0, limit)
  return `
    <main class="page">
      <header class="topbar">
        <button class="back" data-action="back-device">‹</button>
        <div class="row-main"><h1>${conf.title}</h1><p>${conf.subtitle}</p></div>
        <button class="btn small" data-action="${conf.editAction}">+ 新增</button>
      </header>
      ${conf.filters ? `<div class="filter-row">${conf.filters.map((filter, index) => {
        const option = typeof filter === 'string' ? { value: filter, label: filter } : filter
        const active = app.context.moduleFilter === option.value || (!app.context.moduleFilter && index === 0)
        return `<button class="chip ${active ? 'active' : ''}" data-action="module-filter" data-filter="${esc(option.value)}">${esc(option.label)}</button>`
      }).join('')}</div>` : ''}
      ${items.length ? moduleCards(module, visibleItems) : empty(`还没有${conf.title}`, '新增后会归档在当前设备下，也可以全局搜索。')}
      ${module === 'normal' && items.length > visibleItems.length ? `<button class="btn secondary load-more" data-action="load-more-normal">继续加载（剩余 ${items.length - visibleItems.length} 条）</button>` : ''}
    </main>
  `
}

function moduleConfig(module) {
  const map = {
    normal: { title: '正常状态记录', subtitle: '按设备与分类保存正常状态照片。', editAction: 'edit-normal', filters: [{ value: 'all', label: '全部' }, ...NORMAL_CATEGORIES] },
    faults: { title: '故障案例', subtitle: '记录问题、处理过程和结果。', editAction: 'edit-fault', filters: ['全部', '低', '中', '高', '已解决', '观察中'] },
    flows: { title: '拆装流程', subtitle: '逐张照片记录拆卸或安装步骤。', editAction: 'edit-flow', filters: ['全部', '拆卸', '安装'] },
    principles: { title: '设备原理', subtitle: '记录整机、组件和控制逻辑。', editAction: 'edit-principle', filters: ['全部', '整机原理', '电气原理', '机械原理', '气动原理', '液压原理', '控制逻辑', '组件原理', '经验分享'] },
    improvements: { title: '改善记录', subtitle: '记录为什么改、怎么改、改完效果。', editAction: 'edit-improvement', filters: ['全部', '构想中', '评估中', '实施中', '验证中', '已完成', '已取消'] },
    passwords: { title: '密码库', subtitle: '密码默认隐藏，可点击查看。', editAction: 'edit-password', filters: ['全部', 'PLC密码', 'HMI密码', '电脑密码', '软件账号', '门锁密码', '其他'] },
    criticalParameters: { title: '关键参数', subtitle: '自由记录参数值、影响部件和影响逻辑。', editAction: 'edit-critical-parameter' }
  }
  return map[module] || map.normal
}

function getModuleItems(module) {
  const key = module === 'normal' ? 'normalRecords' : module
  let items = app.state[key].filter((item) => !app.context.deviceId || item.deviceId === app.context.deviceId)
  if (module === 'normal' && app.context.moduleFilter && app.context.moduleFilter !== 'all') {
    items = items.filter((item) => normalCategoryKey(item.categoryKey || item.category) === app.context.moduleFilter)
  } else if (module !== 'normal' && app.context.moduleFilter && app.context.moduleFilter !== '全部') {
    const filter = app.context.moduleFilter
    items = items.filter((item) => {
      if (module === 'faults') return item.level === filter || item.status === filter
      if (module === 'flows') return item.type === filter
      if (module === 'improvements') return item.status === filter
      return item.category === filter
    })
  }
  return [...items].reverse()
}

function moduleCards(module, items) {
  if (module === 'normal') return `<section class="photo-grid">${items.map(photoRecordCard).join('')}</section>`
  return `<section class="grid-list">${items.map((item) => recordCard(item, module)).join('')}</section>`
}

function photoRecordCard(item) {
  const title = `${deviceNameSafe(item.deviceId)} · ${normalCategoryLabel(item.categoryKey || item.category)}`
  return `<article class="photo-card card hold-edit-card" data-action="view-record" data-kind="normalRecords" data-id="${item.id}">
    <div class="photo-card-gallery">${item.photos?.length ? galleryImageTags(item.photos, title, 0, { kind: 'normalRecords', recordId: item.id }) : '<div class="image-fallback">照片数据不可用</div>'}</div>
    <div class="photo-card-copy"><strong>${esc(title)}</strong><small>${item.photos?.length || 0} 张 · ${esc((item.createdAt || '').slice(0,10))}</small></div>
    <div class="edit-mode-actions"><button class="edit-mode-action" data-action="edit-normal" data-id="${item.id}">编辑记录</button><button class="edit-mode-action danger" data-action="delete-record" data-kind="normalRecords" data-id="${item.id}">删除记录</button></div>
  </article>`
}

function recordCard(item, module) {
  const kind = module === 'faults' ? 'faults' : module
  const first = img(item.photos?.[0]?.imageId || item.coverImageId)
  const status = module === 'criticalParameters' ? `${item.value || '未填'}${item.unit ? ` ${item.unit}` : ''}` : (item.status || item.level || item.category || item.type || '记录')
  const summary = module === 'criticalParameters'
    ? [item.affectedComponent ? `影响部件：${item.affectedComponent}` : '', item.impactLogic || item.note || '点击查看影响逻辑'].filter(Boolean).join(' · ')
    : (item.summary || item.symptom || item.description || item.content || item.result || '暂无说明')
  const canDelete = canEditSharedRecord(item)
  return `<article class="record-card card ${canDelete ? 'hold-edit-card' : ''}" data-action="view-record" data-kind="${kind}" data-id="${item.id}">
    <div class="card-head"><span class="badge ${statusClass(status)}">${esc(status)}</span></div>
    <h3>${esc(item.title)}</h3>
    <p>${esc(summary)}</p>
    <div class="split"><span class="muted">${esc(deviceName(item.deviceId) || item.device || '未指定设备')}</span><span class="muted">${esc((item.updatedAt || item.createdAt || '').slice(0,10))}</span></div>
    ${item.photos?.length ? `<div class="preview-grid">${galleryImageTags(item.photos, item.title || '照片', 3, { kind, recordId: item.id })}</div>` : (first ? `<div class="preview-grid">${previewImageTag(item.coverImageId, item.title || '照片')}</div>` : '')}
    ${canDelete ? `<div class="edit-mode-actions"><button class="edit-mode-action" data-action="edit-record" data-kind="${kind}" data-id="${item.id}">编辑</button><button class="edit-mode-action danger" data-action="delete-record" data-kind="${kind}" data-id="${item.id}">删除</button></div>` : ''}
  </article>`
}

function shareBadge(item) {
  if (item.shareStatus === '已分享') return '<span class="badge">团队共享</span>'
  if (item.shareStatus === '待审批') return '<span class="badge warn">待审批</span>'
  if (!isTeamJoined()) return '<span class="badge blue">未加入团队</span>'
  return `<button class="chip" data-action="request-share" data-id="${item.id}">申请分享</button>`
}

function renderLogs() {
  const filter = app.context.logFilter || '全部'
  const keyword = app.context.keyword || ''
  let items = [...app.state.faults].reverse()
  if (filter !== '全部') items = items.filter((item) => [item.level, item.status].includes(filter))
  if (keyword) items = items.filter((item) => [item.title, item.symptom, item.cause, item.process, item.result, deviceName(item.deviceId)].join(' ').toLowerCase().includes(keyword.toLowerCase()))
  return `
    <main class="page">
      <header class="topbar"><div><h1>工作日志</h1><p>记录故障现象、处理过程、结果和现场照片。</p></div><button class="btn small" data-action="edit-fault">+ 新增</button></header>
      <div class="search-box inline"><span>⌕</span><input id="log-search" value="${esc(keyword)}" placeholder="搜索故障、设备、处理过程..."></div>
      <div class="filter-row">${['全部','低','中','高','已解决','观察中'].map((f) => `<button class="chip ${filter === f ? 'active' : ''}" data-action="log-filter" data-filter="${f}">${f}</button>`).join('')}</div>
      ${items.length ? `<section class="grid-list">${items.map((item) => recordCard(item, 'faults')).join('')}</section>` : empty('没有找到相关记录')}
      <div class="section-head"><h2>任务</h2><span data-action="edit-task">+ 新增任务</span></div>
      ${app.state.tasks.length ? `<section class="list card">${[...app.state.tasks].reverse().map(taskRow).join('')}</section>` : empty('还没有任务', '记录需要处理和跟进的事项。')}
      <div class="section-head"><h2>会议</h2><span data-action="edit-meeting">+ 新增会议</span></div>
      ${app.state.meetings.length ? `<section class="list card">${[...app.state.meetings].reverse().map(meetingRow).join('')}</section>` : empty('还没有会议记录', '记录会议时间、内容和待办事项。')}
    </main>
  `
}

function renderSharedLogs() {
  const shared = app.state.faults.filter((item) => item.shareStatus === '已分享').slice(-3).reverse()
  return shared.length ? `<section class="list card">${shared.map((item) => `<div class="row" data-action="view-record" data-kind="faults" data-id="${item.id}"><span class="badge">共享</span><div class="row-main"><span class="row-title">${esc(item.title)}</span><span class="row-meta">${esc(deviceName(item.deviceId))} · ${esc(item.updatedAt || item.createdAt)}</span></div></div>`).join('')}</section>` : empty('还没有团队共享日志', '团员可以把重要工作日志申请分享，管理员审批后进入这里。')
}

function renderFlows() {
  const filter = app.context.flowFilter || '全部'
  const keyword = app.context.keyword || ''
  let items = [...app.state.flows].reverse()
  if (filter !== '全部') items = items.filter((item) => item.type === filter)
  if (keyword) items = items.filter((item) => [item.title, item.summary, item.steps?.map((s) => s.note).join(' '), deviceName(item.deviceId)].join(' ').toLowerCase().includes(keyword.toLowerCase()))
  return `
    <main class="page">
      <header class="topbar"><div><h1>流程</h1><p>全局拆装流程入口。</p></div><button class="btn small" data-action="edit-flow">+ 新增</button></header>
      <div class="search-box inline"><span>⌕</span><input id="flow-search" value="${esc(keyword)}" placeholder="搜索流程、设备、步骤..."></div>
      <div class="filter-row">${['全部','拆卸','安装'].map((f) => `<button class="chip ${filter === f ? 'active' : ''}" data-action="flow-filter" data-filter="${f}">${f}</button>`).join('')}</div>
      ${items.length ? `<section class="grid-list">${items.map(flowCard).join('')}</section>` : empty('没有流程记录')}
    </main>
  `
}

function flowCard(flow) {
  return `<article class="flow-card card" data-action="view-record" data-kind="flows" data-id="${flow.id}">
    <div class="card-head"><span class="badge">${esc(['拆卸', '安装'].includes(flow.type) ? flow.type : '拆卸')}</span><span class="muted">${flow.steps?.length || 0} 步</span></div>
    <h3>${esc(flow.title)}</h3><p>${esc(flow.summary || '暂无说明')}</p>
    <div class="flow-steps">${(flow.steps || []).slice(0, 3).map((s, i) => stepHtml(s, i)).join('')}</div>
  </article>`
}

function stepHtml(step, index) {
  const first = img(step.photos?.[0]?.imageId || step.imageId)
  const imageId = step.photos?.[0]?.imageId || step.imageId
  return `<div class="flow-step ${step.important ? 'important' : ''}"><span class="no">${index + 1}</span>${first ? previewImageTag(imageId, step.title || `步骤${index + 1}`) : '<div></div>'}<div><b>${esc(step.title || `步骤${index + 1}`)}</b><p class="muted">${esc(step.note || step.description || '')}</p></div></div>`
}

function renderTeam() {
  const t = app.state.team
  const member = currentMember()
  if (!isTeamJoined()) {
    return `
      <main class="page">
        <header class="topbar"><div><h1>团队共享</h1><p>创建团队的人自动成为创建者，加入的人默认为成员。</p></div></header>
        <section class="profile-card card">
          <h3>还没有加入团队</h3>
          <p>团队用于共享设备记录和重要工作日志。当前为本机数据，正式云同步接入后可跨手机实时加入。</p>
          <div class="modal-actions">
            <button class="btn" data-action="create-team">创建团队</button>
            <button class="btn secondary" data-action="join-team">加入团队</button>
          </div>
        </section>
        <section class="list card">
          <div class="row"><span class="badge">规则</span><div class="row-main"><span class="row-title">谁创建团队，谁就是创建者</span><span class="row-meta">创建者可指定管理员、取消管理员和移除成员。</span></div></div>
          <div class="row"><span class="badge blue">成员</span><div class="row-main"><span class="row-title">加入团队默认是普通成员</span><span class="row-meta">成员可查看共享内容、提交分享申请。</span></div></div>
        </section>
      </main>
    `
  }
  return `
    <main class="page">
      <header class="topbar"><div><h1>团队共享</h1><p>设备记录互相可见，重要日志可申请共享。</p></div><button class="btn small" data-action="team-settings">团队设置</button></header>
      <section class="profile-card card"><h3>${esc(t.name)}</h3><p>我的身份：${esc(member.role)}。${isTeamAdmin() ? '你可以处理分享审批和管理团队共享内容。' : '你可以查看共享内容，也可以申请分享重要日志。'}</p></section>
      <div class="section-head"><h2>分享审批</h2><span>${isTeamAdmin() ? '管理员处理' : '仅管理员可处理'}</span></div>
      ${renderShareApprovals()}
      <div class="section-head"><h2>成员列表</h2><span data-action="invite-member">邀请成员</span></div>
      <section class="list card">${t.members.map(memberRow).join('')}</section>
      <button class="btn secondary" style="width:100%;margin-top:12px" data-action="join-team">切换 / 重新加入团队</button>
    </main>
  `
}

function renderShareApprovals() {
  if (!isTeamAdmin()) return empty('没有审批权限', '普通成员可以查看共享内容，也可以提交分享申请。')
  const pending = app.state.shareRequests.filter((item) => item.status === '待审批')
  return pending.length ? `<section class="list card">${pending.map((req) => `<div class="row"><span class="badge warn">待审批</span><div class="row-main"><span class="row-title">${esc(req.title)}</span><span class="row-meta">${esc(req.requestedBy)} · ${esc(req.createdAt)}</span></div><button class="chip" data-action="approve-share" data-id="${req.id}">通过</button><button class="chip" data-action="reject-share" data-id="${req.id}">拒绝</button></div>`).join('')}</section>` : empty('没有待审批分享', '成员申请分享的重要日志会出现在这里。')
}

function memberRow(m) {
  const meta = m.role === '创建者' ? '团队创建者，拥有最高管理权限' : m.role === '管理员' ? '可审批分享和管理团队共享内容' : '可查看共享内容并提交分享申请'
  const actions = memberActions(m)
  return `<div class="row"><span class="badge ${m.role === '成员' ? 'blue' : ''}">${esc(m.role)}</span><div class="row-main"><span class="row-title">${esc(m.name)}</span><span class="row-meta">${esc(meta)}</span></div>${actions}</div>`
}

function memberActions(m) {
  if (!isTeamOwner() || m.id === app.state.team.ownerId) return ''
  const adminBtn = m.role === '管理员'
    ? `<button class="chip" data-action="demote-member" data-id="${m.id}">取消管理员</button>`
    : `<button class="chip" data-action="promote-member" data-id="${m.id}">设为管理员</button>`
  return `${adminBtn}<button class="chip" data-action="remove-member" data-id="${m.id}">移除</button>`
}

function renderMe() {
  const p = app.state.profile
  return `
    <main class="page">
      <header class="topbar"><div><h1>我的</h1><p>个人信息、备份、设置、关于App。</p></div><button class="round avatar" data-action="profile-settings">${avatarHtml()}</button></header>
      <section class="profile-card card"><h3>${esc(p.name || '维修工程师')}</h3><p>${esc(p.phone || '未填电话')} · ${esc(p.email || '未填邮箱')}</p><button class="btn secondary" data-action="profile-settings">编辑个人资料和偏好设置</button></section>
      <section class="data-safety card">
        <div class="card-head"><div><span class="eyebrow">DATA SAFETY</span><h3>本机数据保护</h3></div><span class="badge">运行正常</span></div>
        <div class="safety-row"><span>照片独立副本</span><b>已启用</b></div>
        <div class="safety-row"><span>完整备份包含照片</span><b>已启用</b></div>
        <p>删除系统相册原图不会影响已保存照片；卸载 App 前请先导出完整备份。</p>
      </section>
      <section class="settings-list">
        <button class="btn secondary" data-page="team">团队共享</button>
        <button class="btn secondary" data-action="export-backup">本地备份 / 导出JSON</button>
        <button class="btn secondary" data-action="import-backup">从备份恢复 / 导入JSON</button>
        <button class="btn secondary" data-action="cloud-backup">云端同步</button>
        <button class="btn secondary" data-action="privacy-policy">隐私政策</button>
        <button class="btn secondary" data-action="about-app">关于App</button>
      </section>
    </main>
  `
}

function bindHoldClass() {
  window.WorkbenchUI?.bindLongPress(document.body)
}



/* forms.js */

const kindMap = {
  normalRecords: 'normalRecords',
  faults: 'faults',
  flows: 'flows',
  principles: 'principles',
  improvements: 'improvements',
  passwords: 'passwords',
  criticalParameters: 'criticalParameters',
  electricalKnowledge: 'electricalKnowledge',
  tasks: 'tasks',
  meetings: 'meetings'
}

function showWorkshopForm(id) {
  const item = id ? workshopById(id) : null
  showModal(`
    <div class="modal-head"><h2>${item ? '编辑车间' : '新增车间'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>车间名称</label><input id="name" class="input" value="${esc(item?.name || '')}" placeholder="例如：4车间"></div>
    <div class="field"><label>车间照片</label>${photoPicker()}</div>
    ${item?.coverImageId ? `<div class="preview-grid">${previewImageTag(item.coverImageId, item.name || '车间照片')}</div>` : ''}
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  $('#save').onclick = async () => {
    const name = $('#name').value.trim()
    if (!name) return toast('请填写车间名称')
    const target = item || { id: uid('workshop'), name, coverImageId: '', devices: [] }
    target.name = name
    const files = selectedFiles()
    if (files.length) {
      const photos = await storeFiles(files)
      if (!photos[0]) return toast('照片处理失败，请重新选择')
      target.coverImageId = photos[0].imageId
    }
    if (!item) workshops().push(target)
    await saveState()
    closeModal()
    render()
    toast('已保存')
  }
}

function showWorkshopMenu(id) {
  const item = workshopById(id)
  showModal(`
    <div class="modal-head"><h2>车间管理</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="settings-list">
      <button class="btn secondary" id="edit">编辑名称</button>
      <button class="btn secondary" id="photo">更换车间照片</button>
      <button class="btn danger" id="delete">删除车间</button>
    </div>
  `, { center: true })
  $('#edit').onclick = () => showWorkshopForm(id)
  $('#photo').onclick = () => showWorkshopForm(id)
  $('#delete').onclick = () => deleteWorkshop(id)
}

function deleteWorkshop(id) {
  const item = workshopById(id)
  if (!item) return
  confirmDialog('删除车间', `确认删除“${item.name}”和其中 ${item.devices.length} 台设备吗？为避免误删知识，关联记录会保留但不再关联已删除设备。`, async () => {
    app.state.workshops = app.state.workshops.filter((workshop) => workshop.id !== id)
    await saveState()
    app.page = 'workshops'
    render()
    toast('车间已删除')
  })
}

function showDeviceForm(id) {
  const w = workshopById(app.context.workshopId) || workshops()[0]
  const item = id ? deviceById(w.id, id) : null
  showModal(`
    <div class="modal-head"><h2>${item ? '编辑设备' : '新建设备'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>设备名称</label><input id="name" class="input" value="${esc(item?.name || '')}"></div>
    <div class="field"><label>所属车间</label><select id="workshop" class="select">${workshops().map((ws) => `<option value="${ws.id}" ${ws.id === w.id ? 'selected' : ''}>${esc(ws.name)}</option>`).join('')}</select></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  $('#save').onclick = async () => {
    const name = $('#name').value.trim()
    if (!name) return toast('请填写设备名称')
    const targetWorkshop = workshopById($('#workshop').value)
    let device = item || { id: uid('device'), photos: [], createdAt: now() }
    device.name = name
    device.code = device.code || ''
    device.owner = device.owner || ''
    device.updatedAt = now()
    if (!item) targetWorkshop.devices.push(device)
    if (item && targetWorkshop.id !== app.context.workshopId) {
      workshopById(app.context.workshopId).devices = workshopById(app.context.workshopId).devices.filter((d) => d.id !== item.id)
      targetWorkshop.devices.push(device)
      app.context.workshopId = targetWorkshop.id
    }
    await saveState()
    closeModal()
    render()
    toast('设备已保存')
  }
}

function showDeviceMenu(id) {
  const item = deviceById(app.context.workshopId, id)
  showModal(`
    <div class="modal-head"><h2>设备管理</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="settings-list">
      <button class="btn secondary" id="edit">编辑设备</button>
      <button class="btn danger" id="delete">删除设备</button>
    </div>
  `, { center: true })
  $('#edit').onclick = () => showDeviceForm(id)
  $('#delete').onclick = () => deleteDevice(id)
}

function deleteDevice(id) {
  const item = deviceById(app.context.workshopId, id)
  if (!item) return
  confirmDialog('删除设备', `确认删除“${item.name}”吗？相关正常状态和维修记录会保留，但不再关联这个设备。`, async () => {
    const workshop = workshopById(app.context.workshopId)
    workshop.devices = workshop.devices.filter((device) => device.id !== id)
    await saveState()
    app.page = 'workshop'
    render()
    toast('设备已删除')
  })
}

function deviceSelect(selected = app.context.deviceId || '') {
  return `<select id="deviceId" class="select"><option value="">不指定设备</option>${allDevices().map(({ workshop, device }) => `<option value="${device.id}" data-workshop="${workshop.id}" ${device.id === selected ? 'selected' : ''}>${esc(workshop.name)} / ${esc(device.name)}</option>`).join('')}</select>`
}

function currentDeviceDefaults(record = {}) {
  const deviceId = record.deviceId || app.context.deviceId || ''
  const info = deviceId ? findDeviceInfo(deviceId) : null
  return { deviceId, workshopId: record.workshopId || info?.workshop.id || app.context.workshopId || '' }
}

function showNormalForm(id) {
  const record = app.state.normalRecords.find((r) => r.id === id)
  const defs = currentDeviceDefaults(record)
  const selectedCategory = record ? normalCategoryKey(record.categoryKey || record.category) : ''
  let workingPhotos = [...(record?.photos || [])]
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑正常状态' : '新增正常状态'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field two"><div><label>分类</label><select id="category" class="select"><option value="">请选择分类</option>${NORMAL_CATEGORIES.map((option) => `<option value="${option.value}" ${selectedCategory === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}</select></div><div><label>所属设备</label>${deviceSelect(defs.deviceId)}</div></div>
    <div class="field"><label>照片，可多张</label>${photoPicker('files', true)}</div>
    <div id="normal-photo-editor"></div>
    <div id="pending-photo-preview"></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  const paintPhotos = () => {
    const editor = $('#normal-photo-editor')
    if (!editor) return
    const galleryId = registerGallery(workingPhotos, normalCategoryLabel($('#category').value))
    editor.innerHTML = workingPhotos.length ? `<div class="editable-photo-grid">${workingPhotos.map((photo, index) => `<figure><img src="${img(photo.imageId)}" alt="照片 ${index + 1}" draggable="false" data-action="preview-gallery" data-gallery-id="${galleryId}" data-gallery-index="${index}"><button type="button" data-remove-photo="${esc(photo.id)}" aria-label="删除第 ${index + 1} 张照片">×</button><figcaption>${index + 1}</figcaption></figure>`).join('')}</div>` : '<p class="muted">还没有照片，请拍照或从相册多选。</p>'
    editor.querySelectorAll('[data-remove-photo]').forEach((button) => {
      button.onclick = () => {
        if (workingPhotos.length === 1 && !selectedFiles().length) return toast('至少保留一张照片；如需删除整条记录，请返回列表长按记录卡片。')
        workingPhotos = workingPhotos.filter((photo) => photo.id !== button.dataset.removePhoto)
        paintPhotos()
      }
    })
  }
  let pendingUrls = []
  const paintPending = () => {
    pendingUrls.forEach((url) => { if (url.startsWith('blob:')) URL.revokeObjectURL(url) })
    pendingUrls = selectedFiles().map((file) => file.dataUrl || URL.createObjectURL(file))
    const panel = $('#pending-photo-preview')
    if (!panel) return
    panel.innerHTML = pendingUrls.length ? `<p class="muted">待保存照片：${pendingUrls.length} 张</p><div class="editable-photo-grid pending">${pendingUrls.map((src, index) => `<figure><img src="${src}" alt="待保存照片 ${index + 1}" draggable="false"><button type="button" data-remove-pending="${index}" aria-label="移除待保存照片 ${index + 1}">×</button><figcaption>新增 ${index + 1}</figcaption></figure>`).join('')}</div>` : ''
    panel.querySelectorAll('[data-remove-pending]').forEach((button) => {
      button.onclick = () => {
        const removeIndex = Number(button.dataset.removePending)
        const nativeFiles = app.nativeSelections.get('files')
        if (nativeFiles) app.nativeSelections.set('files', nativeFiles.filter((_, index) => index !== removeIndex))
        else {
          const input = $('#files')
          if (typeof DataTransfer === 'undefined') return toast('当前系统不支持单独移除待保存照片，请重新选择这一组照片。')
          const transfer = new DataTransfer()
          ;[...(input.files || [])].forEach((file, index) => { if (index !== removeIndex) transfer.items.add(file) })
          input.files = transfer.files
        }
        paintPending()
      }
    })
  }
  paintPhotos()
  $('#category').addEventListener('change', paintPhotos)
  $('#files').addEventListener('change', paintPending)
  $('#save').onclick = async () => {
    const button = $('#save')
    if (button.disabled) return
    const category = $('#category').value
    const deviceId = $('#deviceId').value
    const files = selectedFiles()
    if (!deviceId) return toast('请选择所属设备')
    if (!category) return toast('请选择分类')
    if (!workingPhotos.length && !files.length) return toast('请至少添加一张照片')
    button.disabled = true
    button.textContent = '正在保存...'
    const original = record ? { ...record, photos: [...record.photos] } : null
    let addedPhotos = []
    let newTarget = null
    try {
      addedPhotos = await storeFiles(files)
      if (addedPhotos.length !== files.length) {
        const detail = app.lastPhotoImportError
        throw new Error(detail ? `${detail.stage}失败：${detail.reason}` : '部分照片处理失败，记录尚未保存')
      }
      const photos = [...workingPhotos, ...addedPhotos].map((photo, index) => ({ ...photo, sortOrder: index }))
      if (!photos.length) throw new Error('照片处理失败，请重新选择')
      const info = findDeviceInfo(deviceId)
      const target = record || { id: uid('normal'), createdAt: now(), title: '', description: '', photos: [] }
      if (!record) newTarget = target
      Object.assign(target, {
        category,
        categoryKey: category,
        deviceId,
        workshopId: info?.workshop.id || '',
        device: info?.device.name || '',
        workshop: info?.workshop.name || '',
        photos,
        updatedAt: now()
      })
      if (!record) app.state.normalRecords.push(target)
      if (info) info.device.updatedAt = now()
      await saveState()
      const removed = (original?.photos || []).filter((photo) => !photos.some((current) => current.imageId === photo.imageId))
      await deletePhotos(removed)
      clearSelectedFiles()
      closeModal()
      render()
      toast('正常状态已保存')
    } catch (error) {
      if (newTarget) app.state.normalRecords = app.state.normalRecords.filter((item) => item.id !== newTarget.id)
      if (record && original) Object.assign(record, original)
      await deletePhotos(addedPhotos)
      button.disabled = false
      button.textContent = '保存'
      toast(error.message || '保存失败，请重试')
    }
  }
}

function showFaultForm(id) {
  const record = app.state.faults.find((r) => r.id === id)
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑故障案例' : '新增故障案例'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>问题标题</label><input id="title" class="input" value="${esc(record?.title || '')}"></div>
    <div class="field two"><div><label>所属设备</label>${deviceSelect(record?.deviceId)}</div><div><label>问题等级</label><select id="level" class="select">${['低','中','高'].map((x) => `<option ${record?.level === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    <div class="field"><label>当前状态</label><select id="status" class="select">${['待处理','进行中','观察中','已解决'].map((x) => `<option ${record?.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
    ${textarea('symptom','问题现象',record)}${textarea('cause','原因分析',record)}${textarea('process','处理过程',record)}${textarea('result','处理结果',record)}
    <div class="field"><label>照片，多张</label>${photoPicker('files', true)}</div>${preview(record)}<div id="pending-photo-preview"></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  bindSimplePendingPreview()
  $('#save').onclick = () => saveRecord('faults', record, collectBase({ level: $('#level').value, status: $('#status').value, symptom: $('#symptom').value.trim(), cause: $('#cause').value.trim(), process: $('#process').value.trim(), result: $('#result').value.trim(), author: app.state.profile.name }))
}

function showPhotoAnnotator(source, onSave) {
  const panel = document.createElement('section')
  panel.className = 'photo-annotator'
  panel.innerHTML = `
    <header><div><span class="eyebrow">PHOTO MARKUP</span><h2>标注步骤照片</h2></div><button type="button" class="annotator-close">×</button></header>
    <div class="annotator-toolbar">
      <button type="button" class="chip active" data-tool="line" data-color="#EF4444">红线</button>
      <button type="button" class="chip" data-tool="line" data-color="#111827">黑线</button>
      <button type="button" class="chip" data-tool="text" data-color="#EF4444">红字</button>
      <button type="button" class="chip" data-tool="text" data-color="#111827">黑字</button>
      <input class="input" id="annotator-text" maxlength="80" placeholder="输入文字后点照片放置">
      <button type="button" class="chip" id="annotator-undo">撤销</button>
    </div>
    <div class="annotator-stage"><canvas></canvas><p hidden>照片加载失败</p></div>
    <footer><button type="button" class="btn secondary annotator-close">取消</button><button type="button" class="btn" id="annotator-save">保存标注</button></footer>`
  document.body.append(panel)
  const canvas = panel.querySelector('canvas')
  const context = canvas.getContext('2d')
  const image = new Image()
  const operations = []
  let tool = 'line'
  let color = '#EF4444'
  let drawing = null

  const point = (event) => {
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }
  }
  const repaint = (previewLine = null) => {
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    for (const operation of [...operations, ...(previewLine ? [previewLine] : [])]) {
      context.strokeStyle = operation.color
      context.fillStyle = operation.color
      context.lineWidth = Math.max(5, canvas.width / 420)
      context.lineCap = 'round'
      if (operation.type === 'line') {
        context.beginPath()
        context.moveTo(operation.x1, operation.y1)
        context.lineTo(operation.x2, operation.y2)
        context.stroke()
      } else {
        context.font = `bold ${Math.max(28, Math.round(canvas.width / 17))}px system-ui, sans-serif`
        context.fillText(operation.text, operation.x, operation.y)
      }
    }
  }
  image.onload = () => {
    const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight))
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    repaint()
  }
  image.onerror = () => { canvas.hidden = true; panel.querySelector('.annotator-stage p').hidden = false }
  image.src = source
  panel.querySelectorAll('[data-tool]').forEach((button) => {
    button.onclick = () => {
      tool = button.dataset.tool
      color = button.dataset.color
      panel.querySelectorAll('[data-tool]').forEach((item) => item.classList.toggle('active', item === button))
    }
  })
  canvas.addEventListener('pointerdown', (event) => {
    const start = point(event)
    if (tool === 'text') {
      const text = panel.querySelector('#annotator-text').value.trim()
      if (!text) return toast('请先输入要添加的文字')
      operations.push({ type: 'text', text, color, x: start.x, y: start.y })
      repaint()
      return
    }
    drawing = { type: 'line', color, x1: start.x, y1: start.y, x2: start.x, y2: start.y }
    canvas.setPointerCapture?.(event.pointerId)
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return
    const end = point(event)
    drawing.x2 = end.x
    drawing.y2 = end.y
    repaint(drawing)
  })
  canvas.addEventListener('pointerup', () => {
    if (!drawing) return
    operations.push(drawing)
    drawing = null
    repaint()
  })
  panel.querySelector('#annotator-undo').onclick = () => { operations.pop(); repaint() }
  panel.querySelectorAll('.annotator-close').forEach((button) => { button.onclick = () => panel.remove() })
  panel.querySelector('#annotator-save').onclick = () => {
    if (!canvas.width || canvas.hidden) return toast('照片尚未加载完成')
    onSave(canvas.toDataURL('image/jpeg', 0.94))
    panel.remove()
  }
}

function flowDraftSteps(record) {
  const drafts = []
  for (const step of record?.steps || []) {
    const photos = step.photos?.length ? step.photos : (step.imageId ? [{ id: uid('photo'), imageId: step.imageId, sortOrder: 0 }] : [])
    if (!photos.length) {
      drafts.push({ id: step.id || uid('draft-step'), note: step.note || step.description || '', photo: null, src: '' })
      continue
    }
    photos.forEach((photo, index) => drafts.push({
      id: index === 0 ? (step.id || uid('draft-step')) : uid('draft-step'),
      note: index === 0 ? (step.note || step.description || '') : '',
      photo,
      src: img(photo.imageId),
      originalSrc: imgOriginal(photo.imageId)
    }))
  }
  return drafts.slice(0, 50)
}

function showFlowForm(id) {
  const record = app.state.flows.find((item) => item.id === id)
  let drafts = flowDraftSteps(record)
  let activeStepId = ''
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑拆装流程' : '新增拆装流程'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>流程标题</label><input id="title" class="input" value="${esc(record?.title || '')}"></div>
    <div class="field two"><div><label>所属设备</label>${deviceSelect(record?.deviceId)}</div><div><label>流程类型</label><select id="type" class="select">${['拆卸','安装'].map((value) => `<option ${record?.type === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div></div>
    <div class="field"><label>整体说明</label><textarea id="summary" class="textarea">${esc(record?.summary || '')}</textarea></div>
    <div class="field"><label>添加步骤照片（最多 50 张）</label>${photoPicker('files', true, '拍一张或选择多张步骤照片')}</div>
    <div class="flow-step-editor-list" id="flow-step-editor"></div>
    <button class="btn" id="save" style="width:100%">完成并保存</button>
  `)

  const paint = () => {
    const editor = $('#flow-step-editor')
    if (!editor) return
    editor.innerHTML = drafts.length ? drafts.map((draft, index) => `
      <article class="flow-step-editor ${activeStepId === draft.id ? 'is-reordering' : ''}" data-step-id="${esc(draft.id)}">
        <header><b>第 ${index + 1} 步</b><span>长按可调整顺序</span></header>
        ${draft.src ? `<img src="${draft.src}" alt="第 ${index + 1} 步照片" draggable="false">` : '<div class="image-failed">旧步骤没有照片，请删除后重新添加</div>'}
        <textarea class="textarea" data-step-note="${esc(draft.id)}" placeholder="备注本步骤需要注意的问题">${esc(draft.note || '')}</textarea>
        <div class="flow-step-tools">
          <button type="button" class="chip" data-step-action="annotate" data-step-id="${esc(draft.id)}" ${draft.src ? '' : 'disabled'}>画线/加文字</button>
          <button type="button" class="chip danger-text" data-step-action="remove" data-step-id="${esc(draft.id)}">删除此步</button>
          <button type="button" class="chip" data-step-action="up" data-step-id="${esc(draft.id)}" ${index === 0 ? 'disabled' : ''}>上移</button>
          <button type="button" class="chip" data-step-action="down" data-step-id="${esc(draft.id)}" ${index === drafts.length - 1 ? 'disabled' : ''}>下移</button>
        </div>
      </article>`).join('') : '<div class="empty compact"><h3>还没有步骤</h3><p>每拍摄或选择一张照片，会自动生成下一步。</p></div>'
    editor.querySelectorAll('[data-step-note]').forEach((input) => {
      input.oninput = () => { const draft = drafts.find((item) => item.id === input.dataset.stepNote); if (draft) draft.note = input.value }
    })
  }

  $('#files').addEventListener('change', async () => {
    const incoming = selectedFiles()
    const available = Math.max(0, 50 - drafts.length)
    if (!available) { clearSelectedFiles(); return toast('一个流程最多 50 步') }
    for (const file of incoming.slice(0, available)) {
      const src = file.dataUrl || URL.createObjectURL(file)
      drafts.push({ id: uid('draft-step'), note: '', photo: null, file, src, originalSrc: src })
    }
    if (incoming.length > available) toast(`已达到 50 步，超出的 ${incoming.length - available} 张未加入`)
    clearSelectedFiles()
    paint()
  })

  let holdTimer = null
  let holdStart = null
  $('#flow-step-editor').addEventListener('pointerdown', (event) => {
    const card = event.target.closest('.flow-step-editor')
    if (!card || event.target.closest('button, textarea')) return
    holdStart = { x: event.clientX, y: event.clientY }
    holdTimer = setTimeout(() => { activeStepId = card.dataset.stepId; if (navigator.vibrate) navigator.vibrate(18); paint() }, 500)
  }, { passive: true })
  $('#flow-step-editor').addEventListener('pointermove', (event) => {
    if (holdTimer && holdStart && Math.hypot(event.clientX - holdStart.x, event.clientY - holdStart.y) > 10) { clearTimeout(holdTimer); holdTimer = null }
  }, { passive: true })
  ;['pointerup', 'pointercancel'].forEach((name) => $('#flow-step-editor').addEventListener(name, () => { clearTimeout(holdTimer); holdTimer = null }, { passive: true }))
  $('#flow-step-editor').addEventListener('contextmenu', (event) => event.preventDefault())
  $('#flow-step-editor').addEventListener('click', (event) => {
    const button = event.target.closest('[data-step-action]')
    if (!button) return
    const index = drafts.findIndex((item) => item.id === button.dataset.stepId)
    if (index < 0) return
    const action = button.dataset.stepAction
    if (action === 'remove') drafts.splice(index, 1)
    if (action === 'up' && index > 0) [drafts[index - 1], drafts[index]] = [drafts[index], drafts[index - 1]]
    if (action === 'down' && index < drafts.length - 1) [drafts[index + 1], drafts[index]] = [drafts[index], drafts[index + 1]]
    if (action === 'annotate') return showPhotoAnnotator(drafts[index].originalSrc || drafts[index].src, (dataUrl) => { drafts[index].file = { name: `步骤${index + 1}-标注.jpg`, type: 'image/jpeg', dataUrl }; drafts[index].src = dataUrl; drafts[index].originalSrc = dataUrl; paint() })
    activeStepId = ''
    paint()
  })

  paint()
  $('#save').onclick = async () => {
    const button = $('#save')
    if (button.disabled) return
    const title = $('#title').value.trim()
    const deviceId = $('#deviceId').value
    if (!title) return toast('请填写流程标题')
    if (!deviceId) return toast('请选择所属设备')
    if (!drafts.length) return toast('请至少添加一张步骤照片')
    if (drafts.some((draft) => !draft.photo && !draft.file)) return toast('请删除没有照片的旧步骤后再保存')
    button.disabled = true
    button.textContent = '正在保存步骤...'
    const addedPhotos = []
    const oldPhotos = (record?.steps || []).flatMap((step) => step.photos || [])
    try {
      const steps = []
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index]
        let photo = draft.photo
        if (draft.file) {
          const stored = await storeFiles([draft.file])
          if (!stored[0]) throw new Error(`第 ${index + 1} 步照片处理失败`)
          photo = stored[0]
          addedPhotos.push(photo)
        }
        photo.sortOrder = 0
        steps.push({ id: draft.id, title: `第${index + 1}步`, note: draft.note.trim(), important: false, photos: [photo] })
      }
      const info = findDeviceInfo(deviceId)
      const target = record || { id: uid('flows'), createdAt: now(), photos: [] }
      Object.assign(target, {
        title,
        deviceId,
        workshopId: info?.workshop.id || '',
        device: info?.device.name || '',
        workshop: info?.workshop.name || '',
        type: $('#type').value,
        summary: $('#summary').value.trim(),
        reverseMode: false,
        steps,
        updatedAt: now()
      })
      if (!record) app.state.flows.push(target)
      if (target.type === '拆卸') {
        let installation = app.state.flows.find((item) => item.generatedFromFlowId === target.id)
        if (!installation) {
          installation = { id: uid('flows'), createdAt: now(), photos: [], generatedFromFlowId: target.id }
          app.state.flows.push(installation)
        }
        Object.assign(installation, {
          title: `${title}（安装）`,
          deviceId,
          workshopId: target.workshopId,
          device: target.device,
          workshop: target.workshop,
          type: '安装',
          summary: `由“${title}”拆卸步骤自动倒序生成，可继续编辑备注和顺序。`,
          reverseMode: false,
          steps: [...steps].reverse().map((step, index) => ({ ...step, id: uid('step'), title: `第${index + 1}步`, photos: [...step.photos] })),
          updatedAt: now()
        })
        target.generatedInstallationId = installation.id
      }
      if (info) info.device.updatedAt = now()
      await saveState()
      const keptIds = new Set(steps.flatMap((step) => step.photos.map((photo) => photo.imageId)))
      await deletePhotos(oldPhotos.filter((photo) => !keptIds.has(photo.imageId)))
      closeModal()
      render()
      toast(target.type === '拆卸' ? '拆卸流程已保存，并生成安装流程' : '安装流程已保存')
    } catch (error) {
      await deletePhotos(addedPhotos)
      button.disabled = false
      button.textContent = '完成并保存'
      toast(error.message || '流程保存失败')
    }
  }
}

function showPrincipleForm(id) {
  const record = app.state.principles.find((r) => r.id === id)
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑设备原理' : '新增设备原理'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>标题</label><input id="title" class="input" value="${esc(record?.title || '')}"></div>
    <div class="field two"><div><label>所属设备</label>${deviceSelect(record?.deviceId)}</div><div><label>原理分类</label><select id="category" class="select">${['整机原理','电气原理','机械原理','气动原理','液压原理','控制逻辑','组件原理','经验分享'].map((x) => `<option ${record?.category === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    ${textarea('description','原理说明正文',record)}${textarea('workflow','工作流程',record)}${textarea('components','关键组件',record)}${textarea('notes','注意事项',record)}
    <div class="field"><label>照片，多张</label>${photoPicker('files', true)}</div>${preview(record)}<div id="pending-photo-preview"></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  bindSimplePendingPreview()
  $('#save').onclick = () => saveRecord('principles', record, collectBase({ category: $('#category').value, description: $('#description').value.trim(), workflow: $('#workflow').value.trim(), components: $('#components').value.trim(), notes: $('#notes').value.trim(), author: app.state.profile.name }))
}

function showImprovementForm(id) {
  const record = app.state.improvements.find((r) => r.id === id)
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑改善记录' : '新增改善记录'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>改善标题</label><input id="title" class="input" value="${esc(record?.title || '')}"></div>
    <div class="field two"><div><label>所属设备</label>${deviceSelect(record?.deviceId)}</div><div><label>当前状态</label><select id="status" class="select">${['构想中','评估中','实施中','验证中','已完成','已取消'].map((x) => `<option ${record?.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    ${textarea('object','改善对象/位置',record)}${textarea('problem','存在问题',record)}${textarea('reason','为什么需要改进',record)}${textarea('plan','怎么改进',record)}${textarea('process','实施过程',record)}${textarea('result','改进结果',record)}
    <div class="field"><label>现场/过程照片</label>${photoPicker('files', true)}</div>${preview(record)}<div id="pending-photo-preview"></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  bindSimplePendingPreview()
  $('#save').onclick = () => saveRecord('improvements', record, collectBase({ status: $('#status').value, object: $('#object').value.trim(), problem: $('#problem').value.trim(), reason: $('#reason').value.trim(), plan: $('#plan').value.trim(), process: $('#process').value.trim(), result: $('#result').value.trim(), owner: app.state.profile.name }))
}

function showPasswordForm(id) {
  const record = app.state.passwords.find((r) => r.id === id)
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑密码' : '新增密码'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>密码标题</label><input id="title" class="input" value="${esc(record?.title || '')}"></div>
    <div class="field two"><div><label>所属设备</label>${deviceSelect(record?.deviceId)}</div><div><label>密码类型</label><select id="category" class="select">${['PLC密码','HMI密码','电脑密码','软件账号','门锁密码','其他'].map((x) => `<option ${record?.category === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
    <div class="field two"><div><label>账号</label><input id="account" class="input" value="${esc(record?.account || '')}"></div><div><label>密码</label><input id="password" class="input" value="${esc(record?.password || '')}"></div></div>
    <div class="field"><label>备注</label><textarea id="note" class="textarea">${esc(record?.note || '')}</textarea></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  $('#save').onclick = () => saveRecord('passwords', record, collectBase({ category: $('#category').value, account: $('#account').value.trim(), password: $('#password').value.trim(), note: $('#note').value.trim() }))
}

function showCriticalParameterForm(id) {
  const record = app.state.criticalParameters.find((r) => r.id === id)
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑关键参数' : '新增关键参数'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>参数名称</label><input id="title" class="input" value="${esc(record?.title || '')}" placeholder="例如：运行温度、转动速度、保压时间"></div>
    <div class="field"><label>所属设备</label>${deviceSelect(record?.deviceId)}</div>
    <div class="field two"><div><label>参数值</label><input id="parameter-value" class="input" value="${esc(record?.value || '')}" placeholder="例如：80"></div><div><label>单位</label><input id="parameter-unit" class="input" value="${esc(record?.unit || '')}" placeholder="例如：℃、rpm、秒"></div></div>
    <div class="field"><label>影响此参数的设备部件</label><input id="affected-component" class="input" value="${esc(record?.affectedComponent || '')}" placeholder="自行填写，例如：机械手、加热器、传感器"></div>
    <div class="field"><label>影响逻辑</label><textarea id="impact-logic" class="textarea" placeholder="说明该部件如何影响参数，以及参数变化会造成什么结果">${esc(record?.impactLogic || '')}</textarea></div>
    <div class="field"><label>备注</label><textarea id="note" class="textarea" placeholder="可选">${esc(record?.note || '')}</textarea></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  $('#save').onclick = () => {
    const title = $('#title').value.trim()
    const value = $('#parameter-value').value.trim()
    if (!title) return toast('请填写参数名称')
    if (!value) return toast('请填写参数值')
    saveRecord('criticalParameters', record, collectBase({
      title,
      value,
      unit: $('#parameter-unit').value.trim(),
      affectedComponent: $('#affected-component').value.trim(),
      impactLogic: $('#impact-logic').value.trim(),
      note: $('#note').value.trim()
    }), false)
  }
}

function parseElectricalSteps(value, existingSteps = []) {
  const oldByTitle = new Map(existingSteps.map((step) => [String(step.title || '').trim(), step]))
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50).map((line, index) => {
    const cleaned = line.replace(/^第?\s*\d+\s*步[：:.、-]?\s*/, '')
    const divider = cleaned.search(/[：:]/)
    const title = (divider >= 0 ? cleaned.slice(0, divider) : cleaned).trim() || `第${index + 1}步`
    const note = divider >= 0 ? cleaned.slice(divider + 1).trim() : ''
    const previous = oldByTitle.get(title)
    return { id: previous?.id || uid('electrical-step'), title, note: note || previous?.note || '', done: Boolean(previous?.done), sortOrder: index }
  })
}

function showElectricalKnowledgeForm(id) {
  const record = app.state.electricalKnowledge.find((item) => item.id === id)
  const type = record?.type || 'note'
  const steps = (record?.steps || []).map((step) => step.title || '').join('\n')
  showModal(`
    <div class="modal-head"><h2>${record ? '编辑电工知识' : '新增电工知识'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>标题</label><input id="title" class="input" value="${esc(record?.title || '')}" placeholder="例如：接触器自锁控制回路检查"></div>
    <div class="field two"><div><label>内容类型</label><select id="electrical-type" class="select">${ELECTRICAL_TYPES.map((item) => `<option value="${item.value}" ${type === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}</select></div><div><label>知识分类</label><input id="electrical-category" class="input" list="electrical-categories" value="${esc(record?.category || '')}" placeholder="可自行填写"></div></div>
    <datalist id="electrical-categories">${electricalCategoryOptions(record?.category || '')}</datalist>
    <div class="field"><label>关联设备（可选）</label>${deviceSelect(record?.deviceId || '')}</div>
    <div class="field"><label>关键词</label><input id="electrical-tags" class="input" value="${esc((record?.tags || []).join('，'))}" placeholder="例如：接触器，热继电器，自锁"></div>
    <div class="field"><label>学习内容 / 原理说明</label><textarea id="electrical-content" class="textarea" placeholder="记录你学到的原理、判断方法或现场经验">${esc(record?.content || '')}</textarea></div>
    <div class="field"><label>关键提醒</label><textarea id="electrical-key-points" class="textarea" placeholder="例如：操作前先确认断电和验电；易错点、风险点写在这里">${esc(record?.keyPoints || '')}</textarea></div>
    <div class="field"><label>操作步骤（每行一步，操作卡和排故卡可逐步执行）</label><textarea id="electrical-steps" class="textarea" placeholder="确认故障现象：记录显示和报警&#10;断电并验电：按现场规程确认无电&#10;检查控制回路">${esc(steps)}</textarea><small class="muted">最多 50 步；可用“步骤标题：说明”记录提示。保存后可在详情页逐步勾选完成。</small></div>
    <div class="field"><label>图片资料，可多张</label>${photoPicker('files', true)}</div>${preview(record)}<div id="pending-photo-preview"></div>
    <label class="electrical-runner-check"><input id="electrical-pin" type="checkbox" ${record?.isPinned ? 'checked' : ''}><span>置顶这条知识，方便现场快速查找</span></label>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  bindSimplePendingPreview()
  $('#save').onclick = () => {
    const title = $('#title').value.trim()
    const category = $('#electrical-category').value.trim()
    const content = $('#electrical-content').value.trim()
    const stepsValue = $('#electrical-steps').value
    if (!title) return toast('请填写知识标题')
    if (!category) return toast('请填写知识分类')
    if (!content && !stepsValue.trim() && !selectedFiles().length && !(record?.photos || []).length) return toast('请至少记录内容、步骤或图片资料')
    saveRecord('electricalKnowledge', record, collectBase({
      title,
      type: $('#electrical-type').value,
      category,
      tags: $('#electrical-tags').value.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
      content,
      keyPoints: $('#electrical-key-points').value.trim(),
      steps: parseElectricalSteps(stepsValue, record?.steps || []),
      isPinned: $('#electrical-pin').checked
    }))
  }
}

function textarea(id, label, record) {
  return `<div class="field"><label>${label}</label><textarea id="${id}" class="textarea">${esc(record?.[id] || '')}</textarea></div>`
}

function preview(record) {
  return record?.photos?.length ? `<div class="preview-grid">${galleryImageTags(record.photos, record.title || '照片')}</div>` : ''
}

function collectBase(extra = {}) {
  const deviceId = $('#deviceId')?.value || app.context.deviceId || ''
  const info = deviceId ? findDeviceInfo(deviceId) : null
  return {
    title: $('#title')?.value.trim() || '未命名记录',
    deviceId,
    workshopId: info?.workshop.id || app.context.workshopId || '',
    device: info?.device.name || '',
    workshop: info?.workshop.name || workshopName(app.context.workshopId),
    ...extra
  }
}

async function saveRecord(kind, record, data, includeFiles = true) {
  if (!data.title) return toast('请填写标题')
  if (record && !canEditSharedRecord(record)) return toast('只有管理员可以编辑团队共享内容')
  const button = $('#save')
  if (button?.disabled) return
  if (button) { button.disabled = true; button.textContent = '正在保存...' }
  const original = record ? { ...record, photos: [...(record.photos || [])] } : null
  const files = includeFiles ? selectedFiles() : []
  let addedPhotos = []
  let target = record
  try {
    if (files.length) {
      addedPhotos = await storeFiles(files)
      if (addedPhotos.length !== files.length) {
        const detail = app.lastPhotoImportError
        throw new Error(detail ? `${detail.stage}失败：${detail.reason}` : '部分照片处理失败，记录尚未保存，请重新选择失败的照片')
      }
    }
    target = record || { id: uid(kind), createdAt: now(), photos: [] }
    if (!target.createdById) target.createdById = app.state.profile.id
    if (!target.createdByName) target.createdByName = app.state.profile.name || '维修工程师'
    Object.assign(target, data, { photos: [...(target.photos || []), ...addedPhotos] })
    touchUpdated(target)
    if (!record) app.state[kind].push(target)
    const info = target.deviceId ? findDeviceInfo(target.deviceId) : null
    if (info) info.device.updatedAt = now()
    await saveState()
    clearSelectedFiles()
    closeModal()
    render()
    toast('已保存')
  } catch (error) {
    if (!record && target) app.state[kind] = app.state[kind].filter((item) => item.id !== target.id)
    if (record && original) Object.assign(record, original)
    await deletePhotos(addedPhotos)
    if (button) { button.disabled = false; button.textContent = '保存' }
    toast(error.message || '保存失败，请重试')
  }
}

function showRecordDetail(kind, id) {
  const list = app.state[kindMap[kind]]
  const r = list?.find((item) => item.id === id)
  if (!r) return
  const canEdit = canEditSharedRecord(r)
  const passwordBlock = kind === 'passwords' ? `<p><b>账号：</b>${esc(r.account || '未填')}</p><p><b>密码：</b><span id="pwd">******</span> <button class="chip" id="toggle-pwd">显示/隐藏</button></p>` : ''
  const flowAction = kind === 'flows' && r.steps?.length ? '<button class="btn flow-run-button" id="run-flow">开始逐步执行</button>' : ''
  const electricalAction = kind === 'electricalKnowledge' && r.steps?.length ? '<button class="btn flow-run-button" id="run-electrical">按步骤操作</button>' : ''
  const displayTitle = kind === 'normalRecords' ? `${deviceNameSafe(r.deviceId)} · ${normalCategoryLabel(r.categoryKey || r.category)}` : r.title
  const detailKeys = kind === 'normalRecords' ? [] : ['value','unit','affectedComponent','impactLogic','symptom','cause','process','result','description','workflow','components','notes','object','problem','reason','plan','note','content','summary','keyPoints']
  const details = detailKeys.filter((k) => r[k]).map((k) => `<p><b>${labelOf(k)}：</b>${esc(r[k])}</p>`).join('')
  showModal(`
    <div class="modal-head"><h2>${esc(displayTitle)}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="muted">${kind === 'electricalKnowledge' ? `${esc(electricalTypeLabel(r.type))} · ${esc(r.category || '其他')} · ` : ''}${esc(workshopName(r.workshopId))} · ${esc(deviceNameSafe(r.deviceId))} · ${esc(r.updatedAt || r.createdAt)}</p>
    ${kind === 'electricalKnowledge' && r.tags?.length ? `<p class="muted">关键词：${esc(r.tags.join(' / '))}</p>` : ''}
    ${passwordBlock}${flowAction}${electricalAction}${details || '<p class="muted">暂无详情</p>'}
    ${kind === 'flows' ? `<div class="flow-steps">${(r.steps || []).map((s, i) => stepHtml(s, i)).join('')}</div>` : ''}
    ${kind === 'electricalKnowledge' && r.steps?.length ? `<div class="electrical-step-list">${r.steps.map((s, i) => `<div class="electrical-step ${s.done ? 'done' : ''}"><span class="electrical-step-number">${i + 1}</span><div><b>${esc(s.title)}</b>${s.note ? `<p>${esc(s.note)}</p>` : ''}</div></div>`).join('')}</div>` : ''}
    ${['flows', 'criticalParameters', 'passwords'].includes(kind) ? '' : (r.photos?.length ? `<div class="preview-grid">${galleryImageTags(r.photos, displayTitle, 0, { kind, recordId: r.id })}</div>` : '<p class="muted">这条记录还没有添加照片</p>')}
    ${canEdit ? '<div class="modal-actions"><button class="btn secondary" id="edit-record">编辑</button><button class="btn danger" id="delete-record">删除</button></div>' : '<p class="muted">这是团队共享内容，只有管理员可以编辑或删除。</p>'}
  `)
  if ($('#toggle-pwd')) $('#toggle-pwd').onclick = () => { $('#pwd').textContent = $('#pwd').textContent === '******' ? (r.password || '') : '******' }
  if ($('#run-flow')) $('#run-flow').onclick = () => showFlowRunner(r)
  if ($('#run-electrical')) $('#run-electrical').onclick = () => showElectricalRunner(r)
  if ($('#edit-record')) $('#edit-record').onclick = () => editRecord(kind, id)
  if ($('#delete-record')) $('#delete-record').onclick = () => deleteRecord(kind, id)
}

function showElectricalRunner(record) {
  const steps = record.steps || []
  if (!steps.length) return toast('这条知识还没有可执行步骤')
  document.querySelector('.flow-runner')?.remove()
  const runner = document.createElement('section')
  runner.className = 'flow-runner'
  let index = Math.max(0, steps.findIndex((step) => !step.done))
  if (index < 0) index = 0
  const paint = () => {
    const step = steps[index]
    const progress = electricalProgress(record)
    runner.innerHTML = `
      <header><div><span class="eyebrow">ELECTRICAL GUIDE</span><h2>${esc(record.title)}</h2></div><button class="runner-close" aria-label="关闭执行模式">×</button></header>
      <div class="runner-progress"><i style="width:${((index + 1) / steps.length) * 100}%"></i></div>
      <div class="runner-count">步骤 ${index + 1} / ${steps.length} · 已完成 ${progress.done} 步</div>
      <article class="runner-card ${step.done ? 'important' : ''}"><span class="runner-number">${index + 1}</span><h3>${esc(step.title)}</h3><p>${esc(step.note || '按现场条件完成本步骤，并确认安全措施。')}</p><label class="electrical-runner-check"><input id="electrical-step-done" type="checkbox" ${step.done ? 'checked' : ''}><span>本步骤已完成</span></label></article>
      <footer><button class="btn secondary" id="runner-prev" ${index === 0 ? 'disabled' : ''}>上一步</button><button class="btn" id="runner-next">${index === steps.length - 1 ? '完成操作' : '下一步'}</button></footer>
    `
    runner.querySelector('.runner-close').onclick = () => runner.remove()
    runner.querySelector('#electrical-step-done').onchange = async (event) => {
      step.done = event.target.checked
      touchUpdated(record)
      await saveState()
      paint()
    }
    runner.querySelector('#runner-prev').onclick = () => { if (index > 0) { index -= 1; paint() } }
    runner.querySelector('#runner-next').onclick = async () => {
      if (index < steps.length - 1) { index += 1; paint(); return }
      if (!step.done) {
        step.done = true
        touchUpdated(record)
        await saveState()
      }
      runner.remove()
      render()
      toast('已完成操作卡')
    }
  }
  paint()
  document.body.append(runner)
}

function showFlowRunner(flow) {
  const steps = [...(flow.steps || [])]
  if (!steps.length) return toast('这个流程还没有步骤')
  document.querySelector('.flow-runner')?.remove()
  const runner = document.createElement('section')
  runner.className = 'flow-runner'
  let index = 0

  const paint = () => {
    const step = steps[index]
    const photo = step.photos?.[0]
    runner.innerHTML = `
      <header><div><span class="eyebrow">GUIDED PROCEDURE</span><h2>${esc(flow.title)}</h2></div><button class="runner-close" aria-label="关闭执行模式">×</button></header>
      <div class="runner-progress"><i style="width:${((index + 1) / steps.length) * 100}%"></i></div>
      <div class="runner-count">步骤 ${index + 1} / ${steps.length} · ${esc(flow.type || '拆卸')}</div>
      <article class="runner-card ${step.important ? 'important' : ''}">
        <span class="runner-number">${index + 1}</span>
        ${photo ? `<div class="runner-photo">${previewImageTag(photo.imageId, step.title || `步骤${index + 1}`)}</div>` : ''}
        <h3>${esc(step.title || `步骤${index + 1}`)}</h3>
        <p>${esc(step.note || step.description || '按照片和现场情况完成本步骤。')}</p>
        ${step.important ? '<div class="runner-warning">重点步骤：操作前再次确认方向、位置和连接关系。</div>' : ''}
      </article>
      <footer><button class="btn secondary" id="runner-prev" ${index === 0 ? 'disabled' : ''}>上一步</button><button class="btn" id="runner-next">${index === steps.length - 1 ? '完成流程' : '下一步'}</button></footer>
    `
    runner.querySelector('.runner-close').onclick = () => runner.remove()
    runner.querySelector('#runner-prev').onclick = () => { if (index > 0) { index -= 1; paint() } }
    runner.querySelector('#runner-next').onclick = () => {
      if (index < steps.length - 1) { index += 1; paint() } else { runner.remove(); toast('流程执行完成') }
    }
  }
  paint()
  document.body.append(runner)
}

function deviceNameSafe(deviceId) {
  return findDeviceInfo(deviceId)?.device.name || '未指定设备'
}

function labelOf(key) {
  return ({ value: '参数值', unit: '单位', affectedComponent: '影响部件', impactLogic: '影响逻辑', symptom: '问题现象', cause: '原因分析', process: '处理过程', result: '处理结果', description: '说明', workflow: '工作流程', components: '关键组件', notes: '注意事项', object: '改善对象', problem: '存在问题', reason: '原因分析', plan: '改进方案', note: '备注', content: '学习内容 / 原理说明', keyPoints: '关键提醒', summary: '整体说明' })[key] || key
}

function editRecord(kind, id) {
  const map = { normalRecords: showNormalForm, faults: showFaultForm, flows: showFlowForm, principles: showPrincipleForm, improvements: showImprovementForm, passwords: showPasswordForm, criticalParameters: showCriticalParameterForm, electricalKnowledge: showElectricalKnowledgeForm, tasks: showTaskForm, meetings: showMeetingForm }
  return map[kind]?.(id)
}

function deleteRecord(kind, id) {
  const listName = kindMap[kind]
  const list = app.state[listName]
  const record = list?.find((item) => item.id === id)
  if (!record) return
  if (!canEditSharedRecord(record)) return toast('只有管理员可以删除团队共享内容')
  const displayName = kind === 'normalRecords' ? `${deviceNameSafe(record.deviceId)} · ${normalCategoryLabel(record.categoryKey || record.category)}` : record.title
  confirmDialog('确认删除', `删除“${displayName}”及其关联照片后无法恢复，确认吗？`, async () => {
    app.state[listName] = list.filter((item) => item.id !== id)
    const photos = [...(record.photos || []), ...(record.steps || []).flatMap((step) => step.photos || [])]
    await deletePhotos(photos)
    await saveState()
    closeModal()
    render()
    toast('已删除')
  })
}

function confirmDeletePhoto(kind, recordId, photoId, imageId) {
  const listName = kindMap[kind] || kind
  const record = app.state[listName]?.find((item) => item.id === recordId)
  if (!record || !canEditSharedRecord(record)) return toast('当前照片不可删除')
  const photo = (record.photos || []).find((item) => item.id === photoId || item.imageId === imageId)
  if (!photo) return toast('没有找到这张照片')
  if ((record.photos || []).length === 1) {
    return confirmDialog('删除最后一张照片', '这条记录只剩这一张照片，删除后会同时删除整条记录。确认继续吗？', async () => {
      app.state[listName] = app.state[listName].filter((item) => item.id !== recordId)
      await deletePhotos([photo])
      await saveState()
      render()
      toast('照片和记录已删除')
    })
  }
  confirmDialog('删除照片', '确认只删除当前这张照片吗？其他照片和记录内容会保留。', async () => {
    record.photos = record.photos.filter((item) => item.id !== photo.id && item.imageId !== photo.imageId)
    touchUpdated(record)
    await deletePhotos([photo])
    await saveState()
    render()
    toast('照片已删除')
  })
}

function showTaskForm(id) {
  const r = app.state.tasks.find((item) => item.id === id)
  showModal(`
    <div class="modal-head"><h2>${r ? '编辑任务' : '新增任务'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>任务标题</label><input id="title" class="input" value="${esc(r?.title || '')}"></div>
    <div class="field two"><div><label>状态</label><select id="status" class="select">${['待处理','进行中','已完成','取消'].map((x) => `<option ${r?.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div><div><label>截止时间</label><input id="deadline" class="input" value="${esc(r?.deadline || today())}"></div></div>
    <div class="field"><label>所属设备（可选）</label>${deviceSelect(r?.deviceId)}</div>
    <div class="field"><label>任务内容/备注</label><textarea id="content" class="textarea">${esc(r?.content || r?.detail || '')}</textarea></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  $('#save').onclick = () => saveRecord('tasks', r, collectBase({ status: $('#status').value, deadline: $('#deadline').value.trim(), content: $('#content').value.trim() }))
}

function showMeetingForm(id) {
  const r = app.state.meetings.find((item) => item.id === id)
  showModal(`
    <div class="modal-head"><h2>${r ? '编辑会议' : '新增会议'}</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>会议标题</label><input id="title" class="input" value="${esc(r?.title || '')}"></div>
    <div class="field two"><div><label>提醒日期时间</label><input id="time" class="input" value="${esc(r?.time || now())}"></div><div><label>会议地点</label><input id="place" class="input" value="${esc(r?.place || '')}"></div></div>
    <div class="field"><label>讨论内容</label><textarea id="content" class="textarea">${esc(r?.content || '')}</textarea></div>
    <div class="field"><label>待办事项 / 结论</label><textarea id="todo" class="textarea">${esc(r?.todo || r?.conclusion || '')}</textarea></div>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  $('#save').onclick = () => saveRecord('meetings', r, { title: $('#title').value.trim(), time: $('#time').value.trim(), place: $('#place').value.trim(), content: $('#content').value.trim(), todo: $('#todo').value.trim(), photos: r?.photos || [] })
}

function showTasksMeetings() {
  showModal(`
    <div class="modal-head"><h2>任务与会议</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="tabs"><button class="chip active">任务</button><button class="chip">会议</button></div>
    <div class="settings-list">
      <button class="btn" data-action="edit-task">+ 新增任务</button>
      <button class="btn secondary" data-action="edit-meeting">+ 新增会议</button>
    </div>
    <div class="section-head"><h2>任务</h2></div>
    <section class="list card">${app.state.tasks.map((t) => `<div class="row" data-action="edit-task" data-id="${t.id}"><span class="badge">${esc(t.status || '待处理')}</span><div class="row-main"><span class="row-title">${esc(t.title)}</span><span class="row-meta">${esc(t.deadline || '')}</span></div></div>`).join('') || '<div class="row"><span class="muted">暂无任务</span></div>'}</section>
    <div class="section-head"><h2>会议</h2></div>
    <section class="list card">${app.state.meetings.map((m) => `<div class="row" data-action="edit-meeting" data-id="${m.id}"><span class="badge blue">会议</span><div class="row-main"><span class="row-title">${esc(m.title)}</span><span class="row-meta">${esc(m.time || '')}</span></div></div>`).join('') || '<div class="row"><span class="muted">暂无会议</span></div>'}</section>
  `)
}

function showProfileSettings() {
  const p = app.state.profile
  const s = app.state.settings
  showModal(`
    <div class="modal-head"><h2>个人资料与定制</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>头像</label>${photoPicker('avatar', false, '拍照或选择头像')}</div>
    <div class="field"><label>名字</label><input id="name" class="input" value="${esc(p.name || '')}"></div>
    <div class="field two"><div><label>电话</label><input id="phone" class="input" value="${esc(p.phone || '')}"></div><div><label>邮箱</label><input id="email" class="input" value="${esc(p.email || '')}"></div></div>
    <div class="field two"><div><label>主题</label><select id="theme" class="select"><option value="dark">深色模式</option><option value="light">浅色模式</option><option value="system">跟随系统</option></select></div><div><label>字体大小</label><select id="fontSize" class="select"><option>标准</option><option>大</option><option>特大</option></select></div></div>
    <div class="field two"><div><label>图片压缩</label><select id="compression" class="select"><option>标准</option><option>低压缩</option><option>高压缩</option></select></div><div><label>默认拍照质量</label><select id="cameraQuality" class="select"><option>高清</option><option>标准</option><option>省空间</option></select></div></div>
    <label class="field"><input id="autoClearCache" type="checkbox" ${s.autoClearCache ? 'checked' : ''}> 自动删除缓存</label>
    <button class="btn" id="save" style="width:100%">保存</button>
  `)
  $('#theme').value = s.theme
  $('#fontSize').value = s.fontSize
  $('#compression').value = s.compression
  $('#cameraQuality').value = s.cameraQuality
  $('#save').onclick = async () => {
    p.name = $('#name').value.trim()
    p.phone = $('#phone').value.trim()
    p.email = $('#email').value.trim()
    const avatar = selectedFiles('avatar')
    if (avatar.length) {
      const photos = await storeFiles(avatar)
      if (!photos[0]) return toast('头像处理失败，请重新选择')
      p.avatarImageId = photos[0].imageId
    }
    Object.assign(s, { theme: $('#theme').value, fontSize: $('#fontSize').value, compression: $('#compression').value, cameraQuality: $('#cameraQuality').value, autoClearCache: $('#autoClearCache').checked })
    applySettings()
    await saveState()
    closeModal()
    render()
    toast('资料已保存')
  }
}

function showPasswordList() {
  app.page = 'module'
  app.context = { ...app.context, module: 'passwords' }
  render()
}

function requestLogShare(id) {
  if (!isTeamJoined()) return toast('请先创建或加入团队')
  const log = app.state.faults.find((item) => item.id === id)
  if (!log) return
  if (log.shareStatus === '已分享' || log.shareStatus === '待审批') return toast('这条日志已经提交过分享')
  log.shareStatus = '待审批'
  log.shareRequestedBy = app.state.profile.name || '团队成员'
  app.state.shareRequests.push({
    id: uid('share'),
    logId: log.id,
    title: log.title,
    requestedBy: log.shareRequestedBy,
    status: '待审批',
    createdAt: now()
  })
  saveState().then(() => {
    render()
    toast('已提交给管理员审批')
  })
}

function approveShare(id, approved = true) {
  if (!isTeamAdmin()) return toast('只有管理员可以处理分享审批')
  const req = app.state.shareRequests.find((item) => item.id === id)
  if (!req) return
  const log = app.state.faults.find((item) => item.id === req.logId)
  req.status = approved ? '已通过' : '已拒绝'
  req.reviewedAt = now()
  req.reviewedBy = app.state.profile.name || '管理员'
  if (log) {
    log.shareStatus = approved ? '已分享' : '未分享'
    log.shareReviewedBy = req.reviewedBy
    touchUpdated(log)
  }
  saveState().then(() => {
    render()
    toast(approved ? '已通过分享' : '已拒绝分享')
  })
}

function showCreateTeamForm() {
  const p = app.state.profile
  showModal(`
    <div class="modal-head"><h2>创建团队</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="muted">创建团队的人会成为“创建者”，拥有指定管理员和管理成员的权限。</p>
    <div class="field"><label>团队名称</label><input id="team-name" class="input" placeholder="例如：设备维修团队"></div>
    <div class="field"><label>团队密码</label><input id="team-password" class="input" placeholder="给成员加入时使用"></div>
    <div class="field"><label>我的团队昵称</label><input id="member-name" class="input" value="${esc(p.name || '维修工程师')}"></div>
    <button class="btn" id="save-team" style="width:100%">创建团队</button>
  `)
  $('#save-team').onclick = async () => {
    const name = $('#team-name').value.trim()
    if (!name) return toast('请填写团队名称')
    const memberId = uid('member')
    app.state.team = {
      id: uid('team'),
      name,
      password: $('#team-password').value.trim(),
      ownerId: memberId,
      currentMemberId: memberId,
      joinStatus: '已加入',
      members: [{ id: memberId, userId: app.state.profile.id, name: $('#member-name').value.trim() || app.state.profile.name || '维修工程师', role: '创建者', joinedAt: now() }]
    }
    await saveState()
    closeModal()
    render()
    toast('团队已创建，你是创建者')
  }
}

function showJoinTeamForm() {
  const t = app.state.team
  showModal(`
    <div class="modal-head"><h2>加入 / 切换团队</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="muted">加入团队默认是普通成员。当前版本为本机团队数据，如需跨手机加入，需要先通过备份同步或后续接入云端团队。</p>
    <div class="field"><label>团队名称</label><input id="team-name" class="input" value="${esc(t.name || '')}" placeholder="例如：设备维修团队"></div>
    <div class="field"><label>团队密码</label><input id="team-password" class="input" value="" placeholder="输入团队密码"></div>
    <div class="field"><label>我的团队昵称</label><input id="member-name" class="input" value="${esc(app.state.profile.name || '维修工程师')}"></div>
    <button class="btn" id="save-team" style="width:100%">以成员身份加入</button>
    <button class="btn secondary" id="create-team-from-join" style="width:100%;margin-top:10px">我来创建新团队</button>
  `)
  $('#save-team').onclick = async () => {
    const name = $('#team-name').value.trim()
    if (!name) return toast('请填写团队名称')
    const password = $('#team-password').value.trim()
    if (t.name && t.name === name && t.password && t.password !== password) return toast('团队密码不正确')
    const existing = t.members.find((m) => m.userId === app.state.profile.id)
    if (existing) {
      existing.name = $('#member-name').value.trim() || existing.name
      t.currentMemberId = existing.id
    } else {
      const memberId = uid('member')
      t.members.push({ id: memberId, userId: app.state.profile.id, name: $('#member-name').value.trim() || app.state.profile.name || '团队成员', role: '成员', joinedAt: now() })
      t.currentMemberId = memberId
    }
    t.id = t.id || uid('team')
    t.name = name
    if (!t.password) t.password = password
    t.joinStatus = '已加入'
    await saveState()
    closeModal()
    render()
    toast('已加入团队')
  }
  $('#create-team-from-join').onclick = showCreateTeamForm
}

function showTeamSettings() {
  if (!isTeamJoined()) return showCreateTeamForm()
  const t = app.state.team
  showModal(`
    <div class="modal-head"><h2>团队设置</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <div class="field"><label>团队名称</label><input id="team-name" class="input" value="${esc(t.name || '')}" ${isTeamOwner() ? '' : 'disabled'}></div>
    <div class="field"><label>团队密码</label><input id="team-password" class="input" value="${esc(t.password || '')}" ${isTeamOwner() ? '' : 'disabled'}></div>
    <div class="field"><label>添加成员昵称</label><input id="member-name" class="input" placeholder="例如：张工"></div>
    ${isTeamOwner() ? '<button class="btn secondary" id="add-member" style="width:100%">添加普通成员</button>' : '<p class="muted">只有创建者可以修改团队名称、密码和添加成员。</p>'}
    ${isTeamOwner() ? '<button class="btn" id="save-team-setting" style="width:100%;margin-top:10px">保存团队设置</button>' : ''}
  `)
  if ($('#save-team-setting')) $('#save-team-setting').onclick = async () => {
    const name = $('#team-name').value.trim()
    if (!name) return toast('请填写团队名称')
    t.name = name
    t.password = $('#team-password').value.trim()
    await saveState()
    closeModal()
    render()
    toast('团队设置已保存')
  }
  if ($('#add-member')) $('#add-member').onclick = async () => {
    const name = $('#member-name').value.trim()
    if (!name) return toast('请填写成员昵称')
    t.members.push({ id: uid('member'), userId: '', name, role: '成员', joinedAt: now() })
    await saveState()
    closeModal()
    render()
    toast('成员已添加')
  }
}

function setMemberRole(id, role) {
  if (!isTeamOwner()) return toast('只有创建者可以指定管理员')
  const member = app.state.team.members.find((m) => m.id === id)
  if (!member || member.id === app.state.team.ownerId) return
  member.role = role
  saveState().then(() => {
    render()
    toast(role === '管理员' ? '已设为管理员' : '已取消管理员')
  })
}

function removeMember(id) {
  if (!isTeamOwner()) return toast('只有创建者可以移除成员')
  const member = app.state.team.members.find((m) => m.id === id)
  if (!member || member.id === app.state.team.ownerId) return
  confirmDialog('确认移除成员', `移除“${member.name}”后，该成员不再显示在本机团队列表中。确认吗？`, async () => {
    app.state.team.members = app.state.team.members.filter((m) => m.id !== id)
    await saveState()
    closeModal()
    render()
    toast('成员已移除')
  })
}

function cloudSettings() {
  app.state.settings.cloud = app.state.settings.cloud || { endpoint: '', token: '', lastSyncAt: '' }
  return app.state.settings.cloud
}

function cloudEndpoint() {
  return (cloudSettings().endpoint || '').trim().replace(/\/+$/, '')
}

async function cloudRequest(path, options = {}) {
  const endpoint = cloudEndpoint()
  if (!endpoint) throw new Error('请先填写云服务地址')
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  const token = cloudSettings().token
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(`${endpoint}${path}`, { ...options, headers })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.ok === false) throw new Error(data.error || `云服务请求失败：${response.status}`)
  return data
}

function mapCloudRole(role) {
  if (role === 'owner') return '创建者'
  if (role === 'admin') return '管理员'
  return '成员'
}

function applyCloudTeam(team) {
  if (!team) return
  app.state.team = {
    id: team.id || '',
    name: team.name || '',
    password: app.state.team?.password || '',
    ownerId: team.ownerId || '',
    currentMemberId: team.currentMemberId || '',
    joinStatus: '已加入',
    members: (team.members || []).map((member) => ({
      id: member.id,
      userId: member.id === team.currentMemberId ? app.state.profile.id : '',
      name: member.name || '团队成员',
      role: mapCloudRole(member.role),
      joinedAt: member.joinedAt || now()
    }))
  }
}

function cloudPayloadState() {
  const state = normalize(JSON.parse(JSON.stringify(app.state)))
  state.settings = { ...state.settings, cloud: { endpoint: '', token: '', lastSyncAt: state.settings?.cloud?.lastSyncAt || '' } }
  return state
}

function showCloudBackup() {
  const cloud = cloudSettings()
  showModal(`
    <div class="modal-head"><h2>云端同步</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="muted">正式云端服务用于跨手机、跨小程序同步团队数据。第一次使用请先创建云团队或加入云团队。</p>
    <div class="field"><label>云服务地址</label><input id="cloud-endpoint" class="input" value="${esc(cloud.endpoint || '')}" placeholder="例如：https://api.example.com"></div>
    <div class="field"><label>访问令牌</label><input id="cloud-token" class="input" value="${esc(cloud.token || '')}" placeholder="创建或加入团队后自动生成"></div>
    <div class="field two"><div><label>团队名称</label><input id="cloud-team-name" class="input" value="${esc(app.state.team.name || '')}"></div><div><label>团队密码</label><input id="cloud-team-password" class="input" value="${esc(app.state.team.password || '')}"></div></div>
    <div class="field"><label>我的昵称</label><input id="cloud-display-name" class="input" value="${esc(app.state.profile.name || '维修工程师')}"></div>
    <div class="settings-list">
      <button class="btn secondary" id="save-cloud-settings">保存云设置</button>
      <button class="btn secondary" id="test-cloud">测试连接</button>
      <button class="btn" id="create-cloud-team">创建云团队</button>
      <button class="btn secondary" id="join-cloud-team">加入云团队</button>
      <button class="btn" id="push-cloud">上传本机数据到云端</button>
      <button class="btn secondary" id="pull-cloud">从云端读取数据</button>
    </div>
    <p class="muted">最近同步：${esc(cloud.lastSyncAt || '未同步')}</p>
  `)
  $('#save-cloud-settings').onclick = saveCloudSettings
  $('#test-cloud').onclick = testCloudConnection
  $('#create-cloud-team').onclick = createCloudTeam
  $('#join-cloud-team').onclick = joinCloudTeam
  $('#push-cloud').onclick = pushCloudSnapshot
  $('#pull-cloud').onclick = pullCloudSnapshot
}

async function saveCloudSettings() {
  const cloud = cloudSettings()
  cloud.endpoint = $('#cloud-endpoint').value.trim()
  cloud.token = $('#cloud-token').value.trim()
  await saveState()
  toast('云设置已保存')
}

async function testCloudConnection() {
  try {
    await saveCloudSettings()
    const result = await cloudRequest('/health', { method: 'GET' })
    toast(result.ok ? '云服务连接正常' : '云服务连接异常')
  } catch (error) {
    toast(error.message || '连接失败')
  }
}

async function createCloudTeam() {
  try {
    await saveCloudSettings()
    const result = await cloudRequest('/api/team/create', {
      method: 'POST',
      body: JSON.stringify({
        teamName: $('#cloud-team-name').value.trim(),
        password: $('#cloud-team-password').value.trim(),
        displayName: $('#cloud-display-name').value.trim(),
        deviceId: app.state.profile.id
      })
    })
    cloudSettings().token = result.token
    cloudSettings().lastSyncAt = now()
    app.state.team.password = $('#cloud-team-password').value.trim()
    applyCloudTeam(result.team)
    await saveState()
    closeModal()
    render()
    toast('云团队已创建，你是创建者')
  } catch (error) {
    toast(error.message || '创建云团队失败')
  }
}

async function joinCloudTeam() {
  try {
    await saveCloudSettings()
    const result = await cloudRequest('/api/team/join', {
      method: 'POST',
      body: JSON.stringify({
        teamName: $('#cloud-team-name').value.trim(),
        password: $('#cloud-team-password').value.trim(),
        displayName: $('#cloud-display-name').value.trim(),
        deviceId: app.state.profile.id
      })
    })
    cloudSettings().token = result.token
    cloudSettings().lastSyncAt = now()
    app.state.team.password = $('#cloud-team-password').value.trim()
    applyCloudTeam(result.team)
    await saveState()
    closeModal()
    render()
    toast('已加入云团队')
  } catch (error) {
    toast(error.message || '加入云团队失败')
  }
}

async function pushCloudSnapshot() {
  try {
    await saveCloudSettings()
    const result = await cloudRequest('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        version: 1,
        clientUpdatedAt: now(),
        state: cloudPayloadState(),
        images: Object.fromEntries(app.images)
      })
    })
    if (result.team) applyCloudTeam(result.team)
    cloudSettings().lastSyncAt = result.updatedAt || now()
    await saveState()
    closeModal()
    render()
    toast('本机数据已上传云端')
  } catch (error) {
    toast(error.message || '上传失败')
  }
}

async function pullCloudSnapshot() {
  await saveCloudSettings()
  confirmDialog('从云端读取', '云端数据会覆盖当前本机数据。建议先导出本地备份，确认继续吗？', async () => {
    const cloudBefore = { ...cloudSettings() }
    const result = await cloudRequest('/api/sync/pull', { method: 'GET' })
    if (!result.snapshot?.state) throw new Error('云端还没有可恢复的数据')
    app.state = normalize(result.snapshot.state)
    app.state.settings.cloud = { ...cloudBefore, lastSyncAt: result.snapshot.updatedAt || now() }
    if (result.team) applyCloudTeam(result.team)
    app.images = new Map(Object.entries(result.snapshot.images || {}))
    for (const [id, value] of app.images) await dbPut('images', id, value)
    await saveState()
    closeModal()
    render()
    toast('已读取云端数据')
  }, { danger: false, label: '确认读取' })
}

function exportBackup() {
  const images = Object.fromEntries(app.images)
  showModal(`
    <div class="modal-head"><h2>本地备份 / 导出JSON</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <p class="muted">长按全选复制保存。这个同步包可导入 App，也可复制到小程序“团队 - App/小程序同步包”里导入。恢复前会二次确认。</p>
    <textarea id="backup" class="textarea" style="min-height:48vh">${esc(JSON.stringify({ type: 'maintenance-workbench-sync-package', version: 1, source: 'app', exportedAt: now(), state: app.state, workbenchState: app.state, images }))}</textarea>
    <button class="btn" id="select" style="width:100%">全选</button>
  `)
  $('#select').onclick = () => { $('#backup').focus(); $('#backup').select(); toast('已全选') }
}

function importBackup() {
  showModal(`
    <div class="modal-head"><h2>从备份恢复 / 导入JSON</h2><button class="modal-close" data-action="close-modal">×</button></div>
    <textarea id="restore" class="textarea" style="min-height:48vh" placeholder="粘贴备份JSON"></textarea>
    <button class="btn" id="restore-btn" style="width:100%">恢复</button>
  `)
  $('#restore-btn').onclick = () => confirmDialog('确认恢复', '当前本机数据会被备份覆盖，确认继续吗？', async () => {
    const data = JSON.parse($('#restore').value)
    const incomingState = data.state || data.workbenchState || data.snapshot?.workbenchState
    if (!incomingState) throw new Error('备份里没有可恢复的数据')
    app.state = normalize(incomingState)
    for (const [id, value] of Object.entries(data.images || {})) {
      app.images.set(id, value)
      await dbPut('images', id, value)
    }
    await saveState()
    render()
    toast('恢复完成')
  }, { danger: false, label: '确认恢复' })
}

function showSimpleInfo(title, text) {
  showModal(`<div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-action="close-modal">×</button></div><p class="muted">${esc(text)}</p>`, { center: true })
}


/* main.js */

function navigate(page, context = {}) {
  app.page = page
  app.context = context
  render()
  window.scrollTo(0, 0)
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action], [data-page]')
  if (!target) return
  if (target.classList.contains('modal-mask') && event.target !== target) return
  if (target.hasAttribute('data-stop')) return
  event.stopPropagation()

  const page = target.dataset.page
  const action = target.dataset.action
  if (page) return navigate(page)
  if (action === 'privacy-read') return showPrivacyPolicyDetail()
  if (action === 'privacy-accept') return acceptPrivacyPolicy()
  if (action === 'privacy-decline') return declinePrivacyPolicy()
  if (action === 'privacy-back') return showPrivacyConsent()
  if (action === 'close-modal') return closeModal()
  if (action === 'notice') return showSimpleInfo('通知', '当前没有新的系统通知。')
  if (action === 'search') return showSearch()
  if (action === 'quick-photo') return quickPhoto()
  if (action === 'open-workshop') return navigate('workshop', { workshopId: target.dataset.id })
  if (action === 'open-device') return navigate('device', { workshopId: app.context.workshopId, deviceId: target.dataset.id })
  if (action === 'open-device-any') return navigate('device', { workshopId: target.dataset.workshop, deviceId: target.dataset.device })
  if (action === 'back-workshop') return navigate('workshop', { workshopId: app.context.workshopId })
  if (action === 'back-device') return navigate('device', { workshopId: app.context.workshopId, deviceId: app.context.deviceId })
  if (action === 'open-module') {
    const module = target.dataset.module
    return navigate('module', { ...app.context, module, moduleFilter: module === 'normal' ? 'all' : '全部', normalLimit: 24 })
  }

  if (action === 'edit-workshop') return showWorkshopForm(target.dataset.id)
  if (action === 'workshop-menu') return showWorkshopMenu(target.dataset.id)
  if (action === 'delete-workshop') return deleteWorkshop(target.dataset.id)
  if (action === 'edit-device') return showDeviceForm(target.dataset.id)
  if (action === 'device-menu') return showDeviceMenu(target.dataset.id)
  if (action === 'delete-device') return deleteDevice(target.dataset.id)
  if (action === 'edit-normal') return showNormalForm(target.dataset.id)
  if (action === 'edit-record') return editRecord(target.dataset.kind, target.dataset.id)
  if (action === 'edit-fault') return showFaultForm(target.dataset.id)
  if (action === 'edit-flow') return showFlowForm(target.dataset.id)
  if (action === 'edit-principle') return showPrincipleForm(target.dataset.id)
  if (action === 'edit-improvement') return showImprovementForm(target.dataset.id)
  if (action === 'edit-password') return showPasswordForm(target.dataset.id)
  if (action === 'edit-critical-parameter') return showCriticalParameterForm(target.dataset.id)
  if (action === 'edit-electrical') return showElectricalKnowledgeForm(target.dataset.id)
  if (action === 'open-passwords') return showPasswordList()
  if (action === 'edit-task') return showTaskForm(target.dataset.id)
  if (action === 'edit-meeting') return showMeetingForm(target.dataset.id)
  if (action === 'open-tasks') return navigate('logs')
  if (action === 'preview-image') return showImagePreview(target.dataset.imageId, target.getAttribute('alt') || '照片预览')
  if (action === 'preview-gallery') {
    const items = app.gallerySets.get(target.dataset.galleryId) || []
    if (!items.length) return toast('照片数据不存在，请重新添加或从备份恢复')
    return window.WorkbenchUI?.openGallery(items, Number(target.dataset.galleryIndex) || 0, target.getAttribute('alt') || '照片预览')
  }
  if (action === 'view-record') return showRecordDetail(target.dataset.kind, target.dataset.id)
  if (action === 'delete-record') return deleteRecord(target.dataset.kind, target.dataset.id)
  if (action === 'profile-settings') return showProfileSettings()
  if (action === 'request-share') return requestLogShare(target.dataset.id)
  if (action === 'approve-share') return approveShare(target.dataset.id, true)
  if (action === 'reject-share') return approveShare(target.dataset.id, false)
  if (action === 'team-settings') return showTeamSettings()
  if (action === 'create-team') return showCreateTeamForm()
  if (action === 'promote-member') return setMemberRole(target.dataset.id, '管理员')
  if (action === 'demote-member') return setMemberRole(target.dataset.id, '成员')
  if (action === 'remove-member') return removeMember(target.dataset.id)
  if (action === 'invite-member') return showSimpleInfo('邀请成员', '把团队名称和团队密码发给成员即可加入。创建者可以在成员列表中指定管理员；普通成员只能查看共享内容和提交分享申请。')
  if (action === 'join-team') return showJoinTeamForm()
  if (action === 'cloud-backup') return showCloudBackup()
  if (action === 'privacy-policy') return showPrivacyPolicyDetail(false)
  if (action === 'about-app') return showSimpleInfo('关于App', '维修工作台 Maintenance Workbench。让经验沉淀，让维修更简单。')
  if (action === 'export-backup') return exportBackup()
  if (action === 'import-backup') return importBackup()
  if (action === 'log-filter') { app.context.logFilter = target.dataset.filter; return render() }
  if (action === 'flow-filter') { app.context.flowFilter = target.dataset.filter; return render() }
  if (action === 'electrical-type-filter') { app.context.electricalType = target.dataset.filter; return render() }
  if (action === 'electrical-category-filter') { app.context.electricalCategory = target.dataset.filter; return render() }
  if (action === 'module-filter') { app.context.moduleFilter = target.dataset.filter; app.context.normalLimit = 24; return render() }
  if (action === 'load-more-normal') { app.context.normalLimit = (app.context.normalLimit || 24) + 24; return render() }
})

document.addEventListener('workbench-photo-hold', (event) => {
  const detail = event.detail || {}
  confirmDeletePhoto(detail.kind, detail.recordId, detail.photoId, detail.imageId)
})

document.addEventListener('input', (event) => {
  if (event.target.id === 'log-search') {
    app.context.keyword = event.target.value
    render()
  }
  if (event.target.id === 'flow-search') {
    app.context.keyword = event.target.value
    render()
  }
  if (event.target.id === 'electrical-search') {
    app.context.electricalKeyword = event.target.value
    render()
  }
  if (event.target.id === 'global-search') renderSearchResults(event.target.value)
})

document.addEventListener('click', (event) => {
  const input = event.target.closest('input[type="file"]')
  const bridge = window.webkit?.messageHandlers?.photoPicker
  if (!input || !bridge) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const requestId = uid('native-photo')
  app.nativeSelections.set(input.id, [])
  app.nativePhotoRequests.set(requestId, { inputId: input.id, multiple: input.multiple })
  bridge.postMessage({ requestId, multiple: input.multiple })
}, true)

window.receiveNativePhoto = (requestId, name, dataUrl, index, total) => {
  const request = app.nativePhotoRequests.get(requestId)
  if (!request) return
  const files = app.nativeSelections.get(request.inputId) || []
  files.push({ name: name || `照片${index + 1}.jpg`, type: 'image/jpeg', dataUrl })
  app.nativeSelections.set(request.inputId, files)
  const input = $(`#${request.inputId}`)
  const hint = input?.closest('.photo-picker')?.querySelector('small')
  if (hint) hint.textContent = `已选择 ${files.length} / ${total} 张`
}

window.beginNativePhoto = (requestId, name, index, total) => {
  const key = `${requestId}:${index}`
  app.nativePhotoChunks.set(key, { requestId, name, index, total, chunks: [] })
}

window.receiveNativePhotoChunk = (requestId, index, chunk) => {
  const pending = app.nativePhotoChunks.get(`${requestId}:${index}`)
  if (pending) pending.chunks.push(chunk)
}

window.completeNativePhoto = (requestId, index) => {
  const key = `${requestId}:${index}`
  const pending = app.nativePhotoChunks.get(key)
  if (!pending) return false
  app.nativePhotoChunks.delete(key)
  window.receiveNativePhoto(requestId, pending.name, `data:image/jpeg;base64,${pending.chunks.join('')}`, pending.index, pending.total)
  pending.chunks.length = 0
  return true
}

window.finishNativePhotoSelection = (requestId, errorMessage = '') => {
  const request = app.nativePhotoRequests.get(requestId)
  if (!request) return
  app.nativePhotoRequests.delete(requestId)
  for (const key of [...app.nativePhotoChunks.keys()]) {
    if (key.startsWith(`${requestId}:`)) app.nativePhotoChunks.delete(key)
  }
  const files = app.nativeSelections.get(request.inputId) || []
  if (errorMessage) toast(errorMessage)
  if (files.length) {
    toast(`已选择 ${files.length} 张照片`)
    $(`#${request.inputId}`)?.dispatchEvent(new Event('change', { bubbles: true }))
  }
}

$('#file-input').addEventListener('change', async () => {
  const files = selectedFiles('file-input')
  if (!files.length || !app.pendingPhoto) return
  const photos = await storeFiles(files)
  const { workshopId, deviceId } = app.pendingPhoto
  const device = workshopById(workshopId)?.devices.find((item) => item.id === deviceId)
  if (device) {
    device.photos = [...(device.photos || []), ...photos]
    if (!device.coverImageId && photos[0]) device.coverImageId = photos[0].imageId
    device.updatedAt = new Date().toISOString().slice(0, 10)
    await saveState()
    render()
    toast('照片已独立保存到本机')
  }
  app.pendingPhoto = null
  clearSelectedFiles('file-input')
})

function quickPhoto() {
  const firstWorkshop = app.state.workshops[0]
  const firstDevice = firstWorkshop?.devices[0]
  if (!firstWorkshop || !firstDevice) {
    navigate('workshops')
    toast('请先新建设备，再拍照归档')
    return
  }
  app.pendingPhoto = { workshopId: firstWorkshop.id, deviceId: firstDevice.id }
  $('#file-input').click()
}

function showSearch() {
  document.querySelector('#modal-root').innerHTML = `
    <div class="modal-mask" data-action="close-modal">
      <section class="modal" data-stop>
        <div class="modal-head"><h2>搜索</h2><button class="modal-close" data-action="close-modal">×</button></div>
        <div class="search-box inline"><span>⌕</span><input id="global-search" autofocus placeholder="搜索设备、故障、参数、原理、密码..."></div>
        <div id="global-results">${searchRows('')}</div>
      </section>
    </div>
  `
}

function renderSearchResults(keyword) {
  $('#global-results').innerHTML = searchRows(keyword)
}

function searchRows(keyword) {
  const text = keyword.trim().toLowerCase()
  const rows = []
  app.state.workshops.forEach((w) => w.devices.forEach((d) => {
    if (!text || [w.name, d.name, d.location, d.photos?.map((photo) => `${photo.title} ${photo.note}`).join(' ')].join(' ').toLowerCase().includes(text)) {
      rows.push(`<div class="row search-result" data-action="open-device-any" data-workshop="${w.id}" data-device="${d.id}"><span class="badge">设备</span><div class="row-main"><span class="row-title">${esc(d.name)}</span><span class="row-meta">${esc(w.name)} · ${esc(d.location || '未填位置')} · 打开设备档案</span></div><span class="chev">›</span></div>`)
    }
  }))
  ;[
    ['faults', '故障'],
    ['normalRecords', '正常'],
    ['flows', '流程'],
    ['principles', '原理'],
    ['improvements', '改善'],
    ['passwords', '密码'],
    ['criticalParameters', '参数'],
    ['electricalKnowledge', '电工知识']
  ].forEach(([kind, label]) => app.state[kind].forEach((item) => {
    const source = [item.title, item.value, item.unit, item.affectedComponent, item.impactLogic, item.description, item.symptom, item.cause, item.process, item.result, item.summary, item.note, item.notes, item.workflow, item.components, item.object, item.problem, item.reason, item.plan, item.category, item.content, item.keyPoints, item.tags?.join(' '), item.steps?.map((step) => `${step.title} ${step.note}`).join(' '), workshopName(item.workshopId), deviceNameSafe(item.deviceId)].join(' ').toLowerCase()
    if (!text || source.includes(text)) {
      const context = item.keyPoints || item.content || item.impactLogic || item.affectedComponent || item.result || item.cause || item.symptom || item.description || item.summary || item.plan || item.note || '点击查看完整内容'
      rows.push(`<div class="row search-result" data-action="view-record" data-kind="${kind}" data-id="${item.id}"><span class="badge ${knowledgeMeta[kind]?.className || ''}">${label}</span><div class="row-main"><span class="row-title">${esc(recordDisplayTitle(item, kind))}</span><span class="row-meta">${esc(deviceNameSafe(item.deviceId))} · ${esc(context)}</span></div><span class="chev">›</span></div>`)
    }
  }))
  return rows.length ? `<section class="list card">${rows.join('')}</section>` : '<section class="empty card"><h3>没有找到相关记录</h3><p>换一个关键词试试。</p></section>'
}

window.handleNativeBack = () => {
  if (window.WorkbenchUI?.closeGallery()) return true
  const viewer = document.querySelector('.image-viewer')
  if (viewer) { viewer.remove(); return true }
  const runner = document.querySelector('.flow-runner')
  if (runner) { runner.remove(); return true }
  if ($('#modal-root')?.innerHTML) { closeModal(); return true }
  if (app.page === 'module') { navigate('device', { workshopId: app.context.workshopId, deviceId: app.context.deviceId }); return true }
  if (app.page === 'device') { navigate('workshop', { workshopId: app.context.workshopId }); return true }
  if (app.page === 'workshop') { navigate('workshops'); return true }
  if (app.page !== 'home') { navigate('home'); return true }
  return false
}

bootStore()
  .then(() => {
    render()
    requestPrivacyConsent()
    setTimeout(() => upgradeLegacyImagePreviews(), 900)
  })
  .catch((error) => {
    console.error(error)
    document.querySelector('#app').innerHTML = '<main class="page"><section class="empty card"><h3>启动失败</h3><p>请重启应用后再试。</p></section></main>'
  })

const PRIVACY_KEY = 'maintenance_workbench_privacy_accepted_v1'

function requestPrivacyConsent() {
  if (localStorage.getItem(PRIVACY_KEY) === 'yes') return
  setTimeout(showPrivacyConsent, 120)
}

function showPrivacyConsent() {
  showModal(`
    <div class="privacy-consent">
      <div class="modal-head">
        <h2>隐私政策提示</h2>
      </div>
      <p class="privacy-lead">欢迎使用维修工作台。为保障您的知情权和选择权，请您在首次使用前阅读并理解《隐私政策》。</p>
      <div class="privacy-box">
        <p>本应用主要用于记录设备状态、维修日志、拆装流程、改善记录、会议任务、照片和备注等内容。</p>
        <p>当前版本的数据默认保存在本机，不包含广告、统计分析、第三方登录、支付、地图或推送 SDK。您导出备份时，请妥善保管包含现场照片、设备密码或维修资料的文件。</p>
        <p>点击“同意并进入”表示您已阅读并同意本隐私政策；如果您不同意，将无法继续使用本应用。</p>
      </div>
      <button class="privacy-link" data-action="privacy-read">查看完整《隐私政策》</button>
      <div class="modal-actions privacy-actions">
        <button class="btn secondary" data-action="privacy-decline">不同意</button>
        <button class="btn" data-action="privacy-accept">同意并进入</button>
      </div>
    </div>
  `, { center: true, dismissible: false })
}

function showPrivacyPolicyDetail(fromConsent = true) {
  showModal(`
    <div class="modal-head">
      <h2>维修工作台隐私政策</h2>
      ${fromConsent ? '' : '<button class="modal-close" data-action="close-modal">×</button>'}
    </div>
    <div class="privacy-policy-text">
      <p><strong>更新日期：</strong>2026-06-21</p>
      <p><strong>生效日期：</strong>2026-06-21</p>
      <p>维修工作台是一款面向维修人员的设备知识库工具，用于记录设备状态、故障案例、工作日志、拆装流程、设备原理、改善记录、密码信息、会议任务和本地备份。</p>
      <h3>一、我们如何收集和使用信息</h3>
      <p>您在使用过程中主动填写或上传的设备名称、车间名称、维修记录、照片、备注、任务、会议记录、密码信息等，仅用于在本应用内展示、检索、编辑和备份。</p>
      <h3>二、存储方式</h3>
      <p>当前版本默认使用本机存储保存数据。除您主动导出备份或分享内容外，我们不会主动上传、出售或向第三方提供您的记录。</p>
      <h3>三、设备权限</h3>
      <p>当您添加现场照片时，应用可能调用相机或相册选择能力。相关权限仅用于拍照、选择和保存您指定的图片。</p>
      <h3>四、备份与导入</h3>
      <p>您可以导出 JSON 备份文件，也可以从备份恢复数据。备份文件可能包含现场照片、设备资料和密码信息，请妥善保存，避免泄露。</p>
      <h3>五、未成年人保护</h3>
      <p>本应用面向维修工作场景，不专门面向未成年人。如未成年人使用，应在监护人指导下进行。</p>
      <h3>六、联系我们</h3>
      <p>如您对隐私政策或个人信息保护有疑问，可通过应用市场登记的开发者联系方式与我们联系。</p>
    </div>
    <div class="modal-actions privacy-actions">
      ${fromConsent ? '<button class="btn secondary" data-action="privacy-back">返回</button><button class="btn" data-action="privacy-accept">同意并进入</button>' : '<button class="btn" data-action="close-modal">我知道了</button>'}
    </div>
  `, { center: true, dismissible: !fromConsent })
}

function acceptPrivacyPolicy() {
  localStorage.setItem(PRIVACY_KEY, 'yes')
  closeModal()
  toast('已同意隐私政策')
}

function declinePrivacyPolicy() {
  showModal(`
    <div class="modal-head"><h2>需要您的同意</h2></div>
    <p class="privacy-lead">如果不同意《隐私政策》，将无法继续使用维修工作台。您可以返回阅读政策，或同意后进入应用。</p>
    <div class="modal-actions privacy-actions">
      <button class="btn secondary" data-action="privacy-read">查看政策</button>
      <button class="btn" data-action="privacy-accept">同意并进入</button>
    </div>
  `, { center: true, dismissible: false })
}



