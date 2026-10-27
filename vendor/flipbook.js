/* ==========================================================================
   OvdFlipbook — virada de páginas em 3D, código próprio da OVD News.
   Sem dependências. Não é derivado de nenhuma biblioteca de terceiros.

   Uso:
     const book = new OvdFlipbook(elemento, { width, height, display: 'double' | 'single', page: 1 });
     book.on('turning' | 'turned', callback);
     book.next(); book.previous(); book.page(n); book.view(); book.size(); book.destroy();

   Cada filho direto de `elemento` é uma página. No modo 'double' as páginas formam
   folhas (frente = página ímpar, verso = página par seguinte); a capa fica sozinha
   à direita. No modo 'single' cada página é uma folha só com frente.
   ========================================================================== */
(function (global) {
  'use strict';

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const rad = deg => deg * Math.PI / 180;

  const DRAG_THRESHOLD = 8;     // px antes de um clique virar arraste
  const PEEK_ANGLE = 14;        // quanto o canto levanta ao passar o mouse
  const SHADE_STRENGTH = .34;

  function Flipbook(element, options) {
    this.el = element;
    this.o = Object.assign({
      width: 800, height: 560, display: 'double', duration: 720,
      page: 1, cornerSize: 160, peek: true, canDrag: () => true
    }, options);
    this.listeners = {};
    this.b = 0;               // quantidade de folhas já viradas
    this.moving = null;       // { leaf, dir } enquanto uma folha está em movimento
    this.busy = false;        // true durante arraste ou virada (não durante o "espiar" do canto)
    this.anim = null;
    this.press = null;
    this.drag = null;
    this.peekDir = 0;
    this.shaded = [];
    this._build();
  }

  const proto = Flipbook.prototype;

  proto._build = function () {
    const o = this.o;
    const pages = [...this.el.children];
    this.single = o.display === 'single';
    this.N = pages.length;
    this.w = this.single ? o.width : o.width / 2;
    this.h = o.height;
    this.maxB = this.single ? this.N - 1 : Math.floor(this.N / 2);

    this.el.style.width = `${o.width}px`;
    this.el.style.height = `${o.height}px`;

    this.stage = document.createElement('div');
    this.stage.className = 'flipbook-stage';
    this.stage.style.cssText = `position:absolute;inset:0;perspective:${Math.round(o.height * 4)}px;perspective-origin:50% 50%`;

    this.leaves = [];
    const step = this.single ? 1 : 2;
    for (let i = 0; i < pages.length; i += step) {
      this.leaves.push(this._makeLeaf(pages[i], this.single ? null : pages[i + 1] || null));
    }
    this.leaves.forEach(leaf => this.stage.appendChild(leaf.el));
    this.el.appendChild(this.stage);

    const page = clamp(Math.round(o.page) || 1, 1, Math.max(1, this.N));
    this.b = clamp(this.single ? page - 1 : Math.floor(page / 2), 0, this.maxB);
    this._layout();
    this._bind();
  };

  proto._makeLeaf = function (frontPage, backPage) {
    const el = document.createElement('div');
    el.className = 'flip-leaf';
    el.style.cssText = `position:absolute;top:0;left:${this.single ? 0 : this.w}px;width:${this.w}px;height:${this.h}px;transform-origin:0 50%;transform-style:preserve-3d;display:none`;
    const leaf = { el, angle: 0, front: this._makeFace(frontPage, false), back: backPage ? this._makeFace(backPage, true) : null };
    el.appendChild(leaf.front.el);
    if (leaf.back) el.appendChild(leaf.back.el);
    return leaf;
  };

  proto._makeFace = function (page, isBack) {
    const el = document.createElement('div');
    el.className = 'flip-face';
    el.style.cssText = 'position:absolute;inset:0;overflow:hidden;backface-visibility:hidden;-webkit-backface-visibility:hidden';
    if (isBack) el.style.transform = 'rotateY(180deg)';
    page.style.cssText += ';position:absolute;inset:0;width:100%;height:100%';
    const shade = document.createElement('div');
    shade.className = 'flip-shade';
    // A lombada fica à esquerda da frente e à direita do verso (que é visto espelhado).
    const side = isBack ? 'left' : 'right';
    shade.style.cssText = `position:absolute;inset:0;pointer-events:none;opacity:0;background:linear-gradient(to ${side},rgba(0,0,0,.55),rgba(0,0,0,.12) 55%,rgba(0,0,0,0))`;
    el.append(page, shade);
    return { el, shade };
  };

  /* ---------- Estado visível ---------- */

  proto._isVisible = function (i) {
    const b = this.b;
    if (this.moving) return this.single ? i >= b - 1 && i <= b + 1 : i >= b - 2 && i <= b + 1;
    return this.single ? i === b : i === b - 1 || i === b;
  };

  // Posiciona todas as folhas no estado de repouso (exceto a que está em movimento).
  proto._layout = function () {
    const total = this.leaves.length;
    this.leaves.forEach((leaf, i) => {
      const isMoving = this.moving && this.moving.leaf === leaf;
      if (!isMoving) this._setAngle(leaf, i < this.b ? 180 : 0, true);
      leaf.el.style.zIndex = isMoving ? 1000 : (i < this.b ? i : total - i);
      leaf.el.style.display = this._isVisible(i) ? 'block' : 'none';
    });
    this._shade();
  };

  proto._setAngle = function (leaf, angle, skipShade) {
    leaf.angle = angle;
    leaf.el.style.transform = angle ? `rotateY(${-angle}deg)` : 'none';
    if (!skipShade) this._shade();
  };

  // Sombras: a folha em movimento escurece conforme levanta e projeta sombra nas vizinhas.
  proto._shade = function () {
    this.shaded.forEach(shade => { shade.style.opacity = 0; });
    this.shaded = [];
    if (!this.moving) return;
    const { leaf } = this.moving;
    const index = this.leaves.indexOf(leaf);
    const sin = Math.sin(rad(leaf.angle));
    const paint = (face, amount) => {
      if (!face || amount <= 0.005) return;
      face.shade.style.opacity = Math.min(1, amount).toFixed(3);
      this.shaded.push(face.shade);
    };
    paint(leaf.front, leaf.angle < 90 ? sin * SHADE_STRENGTH : 0);
    paint(leaf.back, leaf.angle > 90 ? sin * SHADE_STRENGTH : 0);
    const next = this.leaves[index + 1], prev = this.leaves[index - 1];
    if (next) paint(next.front, sin * SHADE_STRENGTH * 1.15);
    if (prev && !this.single) paint(prev.back, sin * SHADE_STRENGTH * 1.15);
  };

  /* ---------- Animação ---------- */

  proto._stopAnim = function () {
    if (this.anim) cancelAnimationFrame(this.anim.frame);
    this.anim = null;
  };

  proto._animate = function (leaf, to, duration, done, easing) {
    this._stopAnim();
    const from = leaf.angle;
    if (duration <= 0 || from === to) { this._setAngle(leaf, to); done?.(); return; }
    const anim = this.anim = { leaf };
    const start = performance.now();
    const ease = easing || easeInOut;
    const tick = now => {
      if (this.anim !== anim) return;
      const t = clamp((now - start) / duration, 0, 1);
      this._setAngle(leaf, from + (to - from) * ease(t));
      if (t < 1) anim.frame = requestAnimationFrame(tick);
      else { this.anim = null; done?.(); }
    };
    anim.frame = requestAnimationFrame(tick);
  };

  proto._emit = function (name) {
    (this.listeners[name] || []).forEach(callback => { try { callback.call(this, {}, this.pageNumber(), this.view()); } catch (error) { console.error(error); } });
  };

  // Começa a mover a folha que vira no sentido `dir` (1 = próxima, -1 = anterior).
  proto._begin = function (dir) {
    const leaf = dir > 0 ? this.leaves[this.b] : this.leaves[this.b - 1];
    if (!leaf || (dir > 0 && this.b >= this.maxB) || (dir < 0 && this.b <= 0)) return null;
    this._cancelPeek();
    this.moving = { leaf, dir };
    this.busy = true;
    this._layout();
    this._emit('turning');
    return leaf;
  };

  // Termina o movimento: `committed` diz se a folha acabou virada (muda a página) ou voltou.
  proto._end = function (committed) {
    const dir = this.moving.dir;
    if (committed) this.b += dir;
    this.moving = null;
    this.busy = false;
    this._layout();
    this._emit('turned');
  };

  /* ---------- API pública ---------- */

  proto.on = function (name, callback) {
    (this.listeners[name] ||= []).push(callback);
    return this;
  };

  proto._flip = function (dir) {
    if (this.busy) return false;
    const leaf = this._begin(dir);
    if (!leaf) return false;
    const target = dir > 0 ? 180 : 0;
    const distance = Math.abs(target - leaf.angle) / 180;
    this._animate(leaf, target, Math.max(220, this.o.duration * distance), () => this._end(true));
    return true;
  };

  proto.next = function () { return this._flip(1); };
  proto.previous = function () { return this._flip(-1); };

  proto.pageNumber = function () {
    const view = this.view();
    return view[0] || view[1] || 1;
  };

  // Vai para a página `n` (base 1). Uma folha de distância vira com animação; mais que isso salta.
  proto.page = function (n) {
    if (n === undefined) return this.pageNumber();
    if (this.busy) return;
    const target = clamp(this.single ? Math.round(n) - 1 : Math.floor(Math.round(n) / 2), 0, this.maxB);
    const delta = target - this.b;
    if (!delta) return;
    if (Math.abs(delta) === 1) { this._flip(delta); return; }
    this._cancelPeek();
    this.moving = { leaf: this.leaves[delta > 0 ? this.b : this.b - 1], dir: Math.sign(delta) };
    this.busy = true;
    this._emit('turning');
    this.b = target - Math.sign(delta);   // _end soma mais uma folha
    this._end(true);
    if (this.stage.animate) this.stage.animate([{ opacity: .15 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
  };

  // Páginas visíveis (base 1); 0 = lado vazio. Ex.: capa = [0, 1]; miolo = [2, 3].
  proto.view = function () {
    if (this.single) return [this.b + 1];
    const left = this.b > 0 ? 2 * this.b : 0;
    const right = 2 * this.b + 1 <= this.N ? 2 * this.b + 1 : 0;
    return [left, right];
  };

  proto.size = function () { return { width: this.o.width, height: this.o.height }; };

  proto.destroy = function () {
    this._stopAnim();
    this._unbind();
    this.listeners = {};
    this.moving = null;
    this.busy = false;
    this.stage?.remove();
  };

  /* ---------- Ponteiro: arrastar pelo canto e "espiar" ---------- */

  // Em que canto está o ponteiro? 1 = canto da página direita, -1 = canto da esquerda, 0 = nenhum.
  // No modo single qualquer ponto da página serve (o sentido sai do arraste).
  proto._hit = function (event) {
    const rect = this.el.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return 0;
    if (this.single) return 2;
    const corner = Math.min(this.o.cornerSize, this.w * .4);
    if (y > corner && y < rect.height - corner) return 0;
    const right = this.view()[1];
    if (x >= rect.width - corner && right && this.b < this.maxB) return 1;
    if (x <= corner && this.b > 0) return -1;
    return 0;
  };

  proto._bind = function () {
    this.onDown = event => this._pointerDown(event);
    this.onMove = event => this._pointerMove(event);
    this.onUp = event => this._pointerUp(event);
    this.onLeave = () => { if (!this.drag) this._relaxPeek(); };
    this.el.addEventListener('pointerdown', this.onDown);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    this.el.addEventListener('pointercancel', this.onUp);
    this.el.addEventListener('pointerleave', this.onLeave);
  };

  proto._unbind = function () {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onUp);
    this.el.removeEventListener('pointerleave', this.onLeave);
  };

  proto._pointerDown = function (event) {
    if (event.button !== 0 || this.busy || !this.o.canDrag()) return;
    const hit = this._hit(event);
    if (!hit) return;
    this.press = { id: event.pointerId, x: event.clientX, y: event.clientY, dir: hit === 2 ? 0 : hit };
  };

  // Ângulo da folha em arraste a partir da posição do ponteiro.
  proto._dragAngle = function (event) {
    const rect = this.el.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (this.single) {
      const span = this.w * .8, moved = (this.press.x - event.clientX) / span;
      return this.drag.dir > 0 ? 180 * clamp(moved, 0, 1) : 180 - 180 * clamp(-moved, 0, 1);
    }
    return 180 * clamp((2 * this.w - x) / (2 * this.w), 0, 1);
  };

  proto._pointerMove = function (event) {
    const press = this.press;
    if (press && press.id === event.pointerId) {
      if (!this.drag) {
        const dx = event.clientX - press.x, dy = event.clientY - press.y;
        if (Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
        const dir = press.dir || (dx < 0 ? 1 : -1);
        if (this.single && Math.abs(dy) > Math.abs(dx)) { this.press = null; return; }   // rolagem vertical, não vira
        if (this.busy) { this.press = null; return; }
        const leaf = this._begin(dir);
        if (!leaf) { this.press = null; return; }
        this.drag = { id: event.pointerId, dir, leaf, lastX: event.clientX, lastTime: performance.now(), velocity: 0 };
        try { this.el.setPointerCapture(event.pointerId); } catch { /* ignora */ }
      }
      const now = performance.now(), elapsed = now - this.drag.lastTime;
      if (elapsed > 0) this.drag.velocity = (event.clientX - this.drag.lastX) / elapsed;
      this.drag.lastX = event.clientX; this.drag.lastTime = now;
      this._setAngle(this.drag.leaf, this._dragAngle(event));
      event.preventDefault();
      return;
    }
    if (this.o.peek && !this.single && event.pointerType === 'mouse' && event.buttons === 0) this._peek(event);
  };

  proto._pointerUp = function (event) {
    if (this.press && this.press.id === event.pointerId) this.press = null;
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.drag = null;
    try { if (this.el.hasPointerCapture(event.pointerId)) this.el.releasePointerCapture(event.pointerId); } catch { /* ignora */ }
    const angle = drag.leaf.angle;
    // Termina a virada se passou da metade do caminho ou se foi um gesto rápido no mesmo sentido.
    const flick = drag.dir > 0 ? drag.velocity < -.5 : drag.velocity > .5;
    const committed = event.type !== 'pointercancel' && (flick || (drag.dir > 0 ? angle > 70 : angle < 110));
    const target = committed ? (drag.dir > 0 ? 180 : 0) : (drag.dir > 0 ? 0 : 180);
    const distance = Math.abs(target - angle) / 180;
    this._animate(drag.leaf, target, Math.max(160, this.o.duration * distance * .8), () => this._end(committed), easeOut);
  };

  // Ao passar o mouse num canto, a folha levanta um pouco (indica que dá para virar).
  proto._peek = function (event) {
    if (this.busy || !this.o.canDrag()) { this._relaxPeek(); return; }
    const dir = this._hit(event);
    if (dir === this.peekDir) return;
    if (!dir) { this._relaxPeek(); return; }
    this._cancelPeek();
    const leaf = dir > 0 ? this.leaves[this.b] : this.leaves[this.b - 1];
    if (!leaf) return;
    this.peekDir = dir;
    this.moving = { leaf, dir };
    this._layout();
    this._animate(leaf, dir > 0 ? PEEK_ANGLE : 180 - PEEK_ANGLE, 170, null, easeOut);
  };

  proto._relaxPeek = function () {
    if (!this.peekDir || this.busy) return;
    const { leaf, dir } = this.moving;
    this.peekDir = 0;
    this._animate(leaf, dir > 0 ? 0 : 180, 170, () => {
      if (this.busy || this.peekDir) return;
      this.moving = null;
      this._layout();
    }, easeOut);
  };

  // Cancela o "espiar" na hora (usado quando uma virada de verdade começa).
  proto._cancelPeek = function () {
    if (this.busy || !this.moving) return;
    this._stopAnim();
    this.peekDir = 0;
    this.moving = null;
    this._layout();
  };

  global.OvdFlipbook = Flipbook;
})(window);
