/* ==========================================================================
   OvdFlipbook — virada de páginas com dobra de papel, código próprio da OVD News.
   Sem dependências. Não é derivado de nenhuma biblioteca de terceiros.

   Uso:
     const book = new OvdFlipbook(elemento, { width, height, display: 'double' | 'single', page: 1 });
     book.on('turning' | 'turned', callback);
     book.next(); book.previous(); book.page(n); book.view(); book.size(); book.destroy();

   Cada filho direto de `elemento` é uma página. No modo 'double' as páginas formam
   folhas (frente = página ímpar, verso = página par seguinte); a capa fica sozinha
   à direita. No modo 'single' cada página é uma folha só com frente.

   Como a dobra funciona: a folha é um retângulo. O canto solto vai até o ponto P e a
   dobra fica na mediatriz entre o canto original e P. A parte além da dobra é refletida
   (mostrando o verso) e o resto fica plano (mostrando a frente). Tudo em 2D, com
   clip-path e uma matriz de reflexão, mais gradientes de sombra ao longo da dobra.
   ========================================================================== */
(function (global) {
  'use strict';

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const rad = deg => deg * Math.PI / 180;
  const deg = radians => radians * 180 / Math.PI;

  const DRAG_THRESHOLD = 8;     // px antes de um clique virar arraste
  const PEEK_ANGLE = 24;        // quanto o canto levanta ao passar o mouse
  const SINGLE_DRAG_GAIN = 2.2; // no modo página única um arraste curto já dobra bastante
  const PAPER = '#f7f5ef';

  // Recorta um polígono mantendo o lado `side` (+1/-1) da reta com normal `n` que passa por `m`.
  function clipPolygon(points, n, m, side) {
    const out = [];
    const dist = point => side * ((point[0] - m.x) * n.x + (point[1] - m.y) * n.y);
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const da = dist(a), db = dist(b);
      if (da >= 0) out.push(a);
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return out;
  }

  const polygonCss = points => `polygon(${points.map(p => `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`).join(',')})`;

  // Gradiente que escurece a partir da dobra, na direção `v`, dentro de uma caixa w×h.
  function foldGradient(w, h, v, m, alpha, span) {
    const angle = Math.atan2(v.x, -v.y);
    const length = Math.abs(w * Math.sin(angle)) + Math.abs(h * Math.cos(angle));
    const start = length / 2 + (m.x - w / 2) * v.x + (m.y - h / 2) * v.y;
    return `linear-gradient(${deg(angle).toFixed(2)}deg,rgba(0,0,0,${alpha}) ${start.toFixed(1)}px,rgba(0,0,0,0) ${(start + span).toFixed(1)}px)`;
  }

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
    this.stage.style.cssText = 'position:absolute;inset:0';

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

  // A folha ocupa o retângulo da página direita ("referencial da folha"): x de 0 (lombada) a w.
  proto._makeLeaf = function (frontPage, backPage) {
    const el = document.createElement('div');
    el.className = 'flip-leaf';
    el.style.cssText = `position:absolute;top:0;left:${this.single ? 0 : this.w}px;width:${this.w}px;height:${this.h}px;display:none`;
    const shadow = document.createElement('div');
    shadow.style.cssText = 'position:absolute;inset:0;pointer-events:none;display:none';
    const leaf = { el, shadow, angle: 0, cy: this.h, dragP: null, off: { x: 0, y: 0 }, offK: 0, front: this._makeFace(frontPage), back: this._makeFace(backPage) };
    el.append(shadow, leaf.front.el, leaf.back.el);
    return leaf;
  };

  proto._makeFace = function (page) {
    const el = document.createElement('div');
    el.className = 'flip-face';
    el.style.cssText = `position:absolute;inset:0;overflow:hidden;transform-origin:0 0;background:${PAPER}`;
    const content = document.createElement('div');
    content.style.cssText = 'position:absolute;inset:0;transform-origin:0 0';
    if (page) {
      page.style.cssText += ';position:absolute;inset:0;width:100%;height:100%';
      content.appendChild(page);
    }
    const shade = document.createElement('div');
    shade.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    el.append(content, shade);
    return { el, content, shade };
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
      if (isMoving) this._paint(leaf);
      else { leaf.angle = i < this.b ? 180 : 0; this._rest(leaf, i < this.b); }
      leaf.el.style.zIndex = isMoving ? 1000 : (i < this.b ? i : total - i);
      leaf.el.style.display = this._isVisible(i) ? 'block' : 'none';
    });
  };

  // Folha parada: ou plana à direita (frente) ou plana à esquerda (verso).
  proto._rest = function (leaf, flipped) {
    const { front, back } = leaf;
    leaf.shadow.style.display = 'none';
    front.el.style.clipPath = back.el.style.clipPath = 'none';
    front.el.style.transform = 'none';
    front.shade.style.background = back.shade.style.background = 'none';
    front.el.style.display = flipped ? 'none' : 'block';
    back.el.style.display = flipped ? 'block' : 'none';
    back.el.style.transform = `translateX(${-this.w}px)`;
    back.content.style.transform = 'none';
  };

  // Posição do canto solto para um ângulo de 0° (folha à direita) a 180° (à esquerda).
  // A trajetória é uma elipse: o canto sobe um pouco, e é isso que deixa a dobra na diagonal.
  proto._path = function (angle, cy) {
    const t = rad(angle), lift = Math.min(this.h * .2, this.w * .35);
    return { x: this.w * Math.cos(t), y: cy + (cy > 0 ? -1 : 1) * lift * Math.sin(t) };
  };

  proto._setAngle = function (leaf, angle) {
    leaf.angle = angle;
    this._paint(leaf);
  };

  // Desenha a folha em movimento com a dobra calculada a partir do canto solto P.
  proto._paint = function (leaf) {
    const { w, h } = this, cy = leaf.cy;
    let p = leaf.dragP || this._path(leaf.angle, cy);
    if (!leaf.dragP && leaf.offK > 0) p = { x: p.x + leaf.off.x * leaf.offK, y: p.y + leaf.off.y * leaf.offK };
    // O papel não estica: P fica a no máximo `w` do ponto da lombada que está na altura do canto.
    const reach = Math.hypot(p.x, p.y - cy);
    if (reach > w) p = { x: p.x * w / reach, y: cy + (p.y - cy) * w / reach };
    const vx = p.x - w, vy = p.y - cy, length = Math.hypot(vx, vy);
    if (length < .8) { this._rest(leaf, false); return; }

    const n = { x: vx / length, y: vy / length };
    const m = { x: (w + p.x) / 2, y: (cy + p.y) / 2 };
    const sheet = [[0, 0], [w, 0], [w, h], [0, h]];
    const flat = clipPolygon(sheet, n, m, 1);      // lado da lombada: continua plano
    const fold = clipPolygon(sheet, n, m, -1);     // lado do canto: dobrado por cima

    const { front, back, shadow } = leaf;
    const showFlat = flat.length >= 3, showFold = fold.length >= 3;
    front.el.style.display = showFlat ? 'block' : 'none';
    if (showFlat) {
      front.el.style.clipPath = polygonCss(flat);
      front.shade.style.background = foldGradient(w, h, n, m, .26, 70);
    }
    back.el.style.display = showFold ? 'block' : 'none';
    shadow.style.display = showFold ? 'block' : 'none';
    if (showFold) {
      // Reflexão em torno da dobra (a mesma matriz serve para qualquer ângulo).
      const k = 2 * (n.x * m.x + n.y * m.y);
      const matrix = [1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.y, 1 - 2 * n.y * n.y, k * n.x, k * n.y];
      back.el.style.clipPath = polygonCss(fold);
      back.el.style.transform = `matrix(${matrix.map(v => v.toFixed(5)).join(',')})`;
      back.content.style.transform = `translateX(${w}px) scaleX(-1)`;   // o verso é visto espelhado
      back.shade.style.background = foldGradient(w, h, { x: -n.x, y: -n.y }, m, .34, 95);
      shadow.style.clipPath = polygonCss(fold);
      shadow.style.background = foldGradient(w, h, { x: -n.x, y: -n.y }, m, .42, 85);
    }
  };

  /* ---------- Animação ---------- */

  proto._stopAnim = function () {
    if (this.anim) cancelAnimationFrame(this.anim.frame);
    this.anim = null;
  };

  proto._animate = function (leaf, to, duration, done, easing) {
    this._stopAnim();
    const from = leaf.angle, startOffK = leaf.offK;
    if (duration <= 0 || (from === to && !startOffK)) { leaf.offK = 0; this._setAngle(leaf, to); done?.(); return; }
    const anim = this.anim = { leaf };
    const start = performance.now();
    const ease = easing || easeInOut;
    const tick = now => {
      if (this.anim !== anim) return;
      const t = clamp((now - start) / duration, 0, 1);
      leaf.offK = startOffK * (1 - ease(t));
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
  proto._begin = function (dir, cy) {
    const leaf = dir > 0 ? this.leaves[this.b] : this.leaves[this.b - 1];
    if (!leaf || (dir > 0 && this.b >= this.maxB) || (dir < 0 && this.b <= 0)) return null;
    this._cancelPeek();
    leaf.cy = cy === undefined ? this.h : cy;
    leaf.dragP = null; leaf.offK = 0;
    this.moving = { leaf, dir };
    this.busy = true;
    this._layout();
    this._emit('turning');
    return leaf;
  };

  // Termina o movimento: `committed` diz se a folha acabou virada (muda a página) ou voltou.
  proto._end = function (committed) {
    const dir = this.moving.dir;
    this.moving.leaf.offK = 0;
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
    if (x >= rect.width - corner && this.view()[1] && this.b < this.maxB) return 1;
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
    const rect = this.el.getBoundingClientRect();
    const cy = event.clientY - rect.top < this.h / 2 ? 0 : this.h;   // canto de cima ou de baixo
    this.press = { id: event.pointerId, x: event.clientX, y: event.clientY, dir: hit === 2 ? 0 : hit, cy };
  };

  // Posição do canto solto (referencial da folha) a partir do ponteiro.
  proto._dragPoint = function (event) {
    const { press, drag } = this;
    if (this.single) {
      const baseX = drag.dir > 0 ? this.w : -this.w;
      return { x: baseX + (event.clientX - press.x) * SINGLE_DRAG_GAIN, y: press.cy + (event.clientY - press.y) };
    }
    const rect = this.el.getBoundingClientRect();
    return { x: event.clientX - rect.left - this.w, y: event.clientY - rect.top };
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
        const leaf = this._begin(dir, press.cy);
        if (!leaf) { this.press = null; return; }
        this.drag = { id: event.pointerId, dir, leaf, lastX: event.clientX, lastTime: performance.now(), velocity: 0 };
        try { this.el.setPointerCapture(event.pointerId); } catch { /* ignora */ }
      }
      const now = performance.now(), elapsed = now - this.drag.lastTime;
      if (elapsed > 0) this.drag.velocity = (event.clientX - this.drag.lastX) / elapsed;
      this.drag.lastX = event.clientX; this.drag.lastTime = now;
      const leaf = this.drag.leaf;
      leaf.dragP = this._dragPoint(event);
      leaf.angle = deg(Math.acos(clamp(leaf.dragP.x / this.w, -1, 1)));
      this._paint(leaf);
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
    const leaf = drag.leaf, angle = leaf.angle;
    // Continua a partir de onde o ponteiro soltou: o desvio em relação à trajetória some aos poucos.
    const path = this._path(angle, leaf.cy);
    leaf.off = { x: leaf.dragP.x - path.x, y: leaf.dragP.y - path.y };
    leaf.offK = 1; leaf.dragP = null;
    // Termina a virada se passou da metade do caminho ou se foi um gesto rápido no mesmo sentido.
    const flick = drag.dir > 0 ? drag.velocity < -.5 : drag.velocity > .5;
    const committed = event.type !== 'pointercancel' && (flick || (drag.dir > 0 ? angle > 70 : angle < 110));
    const target = committed ? (drag.dir > 0 ? 180 : 0) : (drag.dir > 0 ? 0 : 180);
    const distance = Math.abs(target - angle) / 180;
    this._animate(leaf, target, Math.max(200, this.o.duration * distance * .85), () => this._end(committed), easeOut);
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
    const rect = this.el.getBoundingClientRect();
    leaf.cy = event.clientY - rect.top < this.h / 2 ? 0 : this.h;
    leaf.dragP = null; leaf.offK = 0;
    this.peekDir = dir;
    this.moving = { leaf, dir };
    this._layout();
    this._animate(leaf, dir > 0 ? PEEK_ANGLE : 180 - PEEK_ANGLE, 190, null, easeOut);
  };

  proto._relaxPeek = function () {
    if (!this.peekDir || this.busy) return;
    const { leaf, dir } = this.moving;
    this.peekDir = 0;
    this._animate(leaf, dir > 0 ? 0 : 180, 190, () => {
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
