/**
 * Subtitle rendering, carried over from web/subs.js.
 *
 * Cues are drawn into a DOM overlay on an animation frame rather than handed to
 * a <track>. That is what makes the delay control and the styling possible at
 * all: a <track> cue is fixed at the time written in the file, and its
 * appearance is the browser's business, not ours.
 *
 * Two changes from the server build. There is one layer instead of two, because
 * this player shows a single track per episode. And cues arrive already parsed
 * — the file was read off the viewer's own disk and run through the parsers in
 * lib/subtitles — rather than being fetched as JSON from an endpoint.
 */

const stripTags = (s) => s.replace(/<[^>]*>/g, '');

/**
 * Cue text arrives already escaped as HTML, because that is how it is rendered
 * into the overlay. Search results go through a second escaping pass on their
 * way into the DOM, so the entities have to be decoded back to plain text first
 * — otherwise a quotation mark in the dialogue displays as "&quot;".
 */
const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

export class Subtitles {
  constructor(video, layer) {
    this.video = video;
    this.layer = layer;
    this.cues = null;
    this.delay = 0;
    this.onDelayChange = () => {};
    this.style = {
      size: 3.2,        // vh
      color: '#ffffff',
      bgOpacity: 0.55,
      bottom: 6,        // % from the bottom edge
      outline: true,
    };
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /** @param cues {null | Array<{start:number,end:number,text:string}>} */
  set(cues) {
    this.cues = cues && cues.length ? cues : null;
    this.layer.innerHTML = '';
    this.layer.dataset.shown = '';
  }

  setDelay(seconds) {
    this.delay = Math.round(seconds * 1000) / 1000;
    this.onDelayChange(this.delay);
  }

  nudge(step) {
    this.setDelay(this.delay + step);
  }

  setStyle(patch) {
    Object.assign(this.style, patch);
    this.applyStyle();
  }

  applyStyle() {
    const s = this.style;
    const el = this.layer;
    el.style.fontSize = `${s.size}vh`;
    el.style.color = s.color;
    el.style.setProperty('--sub-bg', `rgba(0,0,0,${s.bgOpacity})`);
    el.style.textShadow = s.outline ? '0 1px 3px #000, 0 0 6px #000' : 'none';
    el.style.bottom = `${s.bottom}%`;
  }

  /**
   * Cues are sorted by start time, so the active ones are found by binary
   * searching for the first cue that starts after `t` and walking back from
   * there. Walking back matters: cues can overlap, and with a delay applied the
   * playhead can land inside several at once.
   */
  activeCues(t) {
    const cues = this.cues;
    if (!cues) return [];
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo - 1; i >= 0 && i > lo - 12; i--) {
      if (cues[i].end > t) out.push(cues[i]);
    }
    return out.reverse();
  }

  loop() {
    requestAnimationFrame(this.loop);
    const now = this.video.currentTime;
    if (!Number.isFinite(now)) return;

    const el = this.layer;
    if (!this.cues) {
      if (el.dataset.shown !== '') {
        el.innerHTML = '';
        el.dataset.shown = '';
      }
      return;
    }

    // A cue is shown at start + delay, so going the other way — from the
    // playhead to a position in the subtitle file — subtracts it.
    const cues = this.activeCues(now - this.delay);
    const html = cues.map((c) => `<span class="cue">${c.text}</span>`).join('');
    if (el.dataset.shown !== html) {
      el.innerHTML = html;
      el.dataset.shown = html;
    }
  }

  search(query) {
    if (!this.cues || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    const out = [];
    for (const cue of this.cues) {
      const plain = decodeEntities(stripTags(cue.text)).replace(/\s+/g, ' ');
      if (plain.toLowerCase().includes(q)) {
        out.push({ time: cue.start + this.delay, text: plain });
        if (out.length >= 200) break;
      }
    }
    return out;
  }
}
