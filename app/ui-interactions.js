(function () {
  'use strict'

  let activeCard = null
  let press = null
  let viewer = null

  function exitEditMode() {
    activeCard?.classList.remove('is-editing')
    activeCard = null
  }

  function enterEditMode(card) {
    if (activeCard && activeCard !== card) activeCard.classList.remove('is-editing')
    activeCard = card
    card.classList.add('is-editing')
    if (navigator.vibrate) navigator.vibrate(18)
  }

  function clearPress() {
    if (!press) return
    clearTimeout(press.timer)
    press = null
  }

  function bindLongPress(root) {
    if (!root || root.dataset.longPressBound === 'true') return
    root.dataset.longPressBound = 'true'

    root.addEventListener('pointerdown', (event) => {
      const photo = event.target.closest('[data-hold-photo]')
      const card = event.target.closest('.hold-edit-card')
      if ((!card && !photo) || event.button > 0 || event.target.closest('button, input, textarea, select, a, label')) return
      clearPress()
      const current = {
        card,
        photo,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        triggered: false,
        timer: setTimeout(() => {
          current.triggered = true
          if (photo) {
            photo.dataset.suppressOpen = 'true'
            if (navigator.vibrate) navigator.vibrate(18)
            photo.dispatchEvent(new CustomEvent('workbench-photo-hold', { bubbles: true, detail: { ...photo.dataset } }))
          } else {
            card.dataset.suppressOpen = 'true'
            enterEditMode(card)
          }
        }, 500)
      }
      press = current
    }, { passive: true })

    root.addEventListener('pointermove', (event) => {
      if (!press || event.pointerId !== press.pointerId) return
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) clearPress()
    }, { passive: true })

    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      root.addEventListener(type, (event) => {
        if (!press || event.pointerId !== press.pointerId) return
        const triggered = press.triggered
        const card = press.card
        const photo = press.photo
        clearPress()
        if (triggered) setTimeout(() => {
          if (card) delete card.dataset.suppressOpen
          if (photo) delete photo.dataset.suppressOpen
        }, 420)
      }, { passive: true })
    }

    root.addEventListener('scroll', clearPress, { passive: true, capture: true })
    root.addEventListener('contextmenu', (event) => {
      if (event.target.closest('.hold-edit-card, [data-hold-photo]')) event.preventDefault()
    })
    root.addEventListener('click', (event) => {
      const photo = event.target.closest('[data-hold-photo]')
      const card = event.target.closest('.hold-edit-card')
      const action = event.target.closest('.edit-mode-action')
      if (action) {
        exitEditMode()
        return
      }
      if (photo?.dataset.suppressOpen === 'true') {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (card?.dataset.suppressOpen === 'true') {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (card && card === activeCard) {
        event.preventDefault()
        event.stopImmediatePropagation()
        exitEditMode()
        return
      }
      if (!card) exitEditMode()
    }, true)
  }

  function closeGallery() {
    if (!viewer) return false
    viewer.remove()
    viewer = null
    return true
  }

  function openGallery(items, startIndex, title) {
    const photos = (Array.isArray(items) ? items : []).filter((item) => item?.src)
    if (!photos.length) return false
    closeGallery()

    let index = Math.max(0, Math.min(Number(startIndex) || 0, photos.length - 1))
    let startX = 0
    let startY = 0
    let tracking = false
    let scale = 1
    let translateX = 0
    let translateY = 0
    let pinchDistance = 0
    let pinchScale = 1
    let lastTap = 0
    const pointers = new Map()
    viewer = document.createElement('section')
    viewer.className = 'gallery-viewer'
    viewer.setAttribute('role', 'dialog')
    viewer.setAttribute('aria-modal', 'true')
    viewer.innerHTML = `
      <header class="gallery-bar"><strong></strong><button type="button" aria-label="关闭照片预览">×</button></header>
      <div class="gallery-stage"><button class="gallery-nav previous" type="button" aria-label="上一张">‹</button><div class="gallery-media"><img draggable="false" alt=""><p>照片加载失败</p></div><button class="gallery-nav next" type="button" aria-label="下一张">›</button></div>
      <footer><span class="gallery-count"></span><small>双指缩放查看原图细节 · 双击复位</small></footer>`

    const image = viewer.querySelector('img')
    const media = viewer.querySelector('.gallery-media')
    const failed = viewer.querySelector('.gallery-media p')
    const heading = viewer.querySelector('strong')
    const count = viewer.querySelector('.gallery-count')
    const previous = viewer.querySelector('.previous')
    const next = viewer.querySelector('.next')

    function zoomLimit() {
      const displayedWidth = image.clientWidth || 1
      const displayedHeight = image.clientHeight || 1
      const sourceScale = Math.max(
        (image.naturalWidth || displayedWidth) / displayedWidth,
        (image.naturalHeight || displayedHeight) / displayedHeight
      )
      return Math.max(3, Math.min(10, sourceScale))
    }

    function clampTransform() {
      if (scale <= 1) {
        scale = 1
        translateX = 0
        translateY = 0
        return
      }
      const mediaRect = media.getBoundingClientRect()
      const maxX = Math.max(0, (image.clientWidth * scale - mediaRect.width) / 2)
      const maxY = Math.max(0, (image.clientHeight * scale - mediaRect.height) / 2)
      translateX = Math.max(-maxX, Math.min(maxX, translateX))
      translateY = Math.max(-maxY, Math.min(maxY, translateY))
    }

    function applyTransform() {
      clampTransform()
      image.style.transform = `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`
      image.style.cursor = scale > 1 ? 'grab' : 'zoom-in'
    }

    function resetZoom() {
      scale = 1
      translateX = 0
      translateY = 0
      pinchDistance = 0
      pinchScale = 1
      pointers.clear()
      applyTransform()
    }

    function paint() {
      const photo = photos[index]
      resetZoom()
      failed.hidden = true
      image.hidden = false
      image.alt = photo.title || title || '照片预览'
      image.src = photo.src
      heading.textContent = photo.title || title || '照片预览'
      count.textContent = `${index + 1} / ${photos.length}`
      previous.disabled = index === 0
      next.disabled = index === photos.length - 1
    }

    function move(delta) {
      const target = Math.max(0, Math.min(index + delta, photos.length - 1))
      if (target === index) return
      index = target
      paint()
    }

    image.addEventListener('error', () => {
      image.hidden = true
      failed.hidden = false
    })
    image.addEventListener('load', () => {
      image.hidden = false
      failed.hidden = true
      resetZoom()
    })
    viewer.querySelector('.gallery-bar button').addEventListener('click', closeGallery)
    previous.addEventListener('click', () => move(-1))
    next.addEventListener('click', () => move(1))
    viewer.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      viewer.setPointerCapture?.(event.pointerId)
      startX = event.clientX
      startY = event.clientY
      tracking = true
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinchDistance = Math.hypot(a.x - b.x, a.y - b.y)
        pinchScale = scale
      }
    }, { passive: true })
    viewer.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return
      const previousPoint = pointers.get(event.pointerId)
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        if (pinchDistance > 0) scale = Math.max(1, Math.min(zoomLimit(), pinchScale * distance / pinchDistance))
        if (scale === 1) { translateX = 0; translateY = 0 }
        tracking = false
        applyTransform()
      } else if (scale > 1) {
        translateX += event.clientX - previousPoint.x
        translateY += event.clientY - previousPoint.y
        tracking = false
        applyTransform()
      }
    }, { passive: true })
    viewer.addEventListener('pointerup', (event) => {
      pointers.delete(event.pointerId)
      if (!tracking) return
      tracking = false
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      if (scale === 1 && Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.25) move(dx < 0 ? 1 : -1)
    }, { passive: true })
    viewer.addEventListener('pointercancel', (event) => { pointers.delete(event.pointerId); tracking = false }, { passive: true })
    viewer.addEventListener('click', (event) => {
      if (event.target === viewer) closeGallery()
    })
    image.addEventListener('click', () => {
      const current = Date.now()
      if (current - lastTap < 320) {
        if (scale > 1) resetZoom()
        else { scale = Math.min(2.5, zoomLimit()); applyTransform() }
      }
      lastTap = current
    })
    document.body.append(viewer)
    paint()
    return true
  }

  document.addEventListener('dragstart', (event) => {
    if (event.target instanceof HTMLImageElement) event.preventDefault()
  })

  window.WorkbenchUI = { bindLongPress, exitEditMode, openGallery, closeGallery }
})()
