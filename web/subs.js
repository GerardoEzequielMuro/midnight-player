/**
 * Subtitle rendering.
 *
 * Cues are drawn into a DOM overlay on an animation frame, not handed to a
 * <track> element. That is what makes the rest possible: two tracks at once,
 * a delay that changes while playing, and styling the browser does not expose.
 * Switching tracks never touches the video element, so playback never stops.
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
  constructor(video, layers) {
    this.video = video;
    this.layers = layers; // { primary: HTMLElement, secondary: HTMLElement }
    this.tracks = { primary: null, secondary: null };
    this.delays = { primary: 0, secondary: 0 };
    // A cue is shown at  start * scale + delay.  Scale stays 1 for a plain
    // offset; automatic alignment sets it when the two are running at
    // different speeds and a single shift cannot fix the whole episode.
    this.scales = { primary: 1, secondary: 1 };
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

  /** @param track {null | {id: string, url: string}} — external files and
   *  tracks extracted from inside the video both arrive as parsed cues. */
  async load(slot, track) {
    if (!track) {
      this.tracks[slot] = null;
      this.layers[slot].innerHTML = '';
      this.layers[slot].dataset.shown = '';
      return null;
    }
    const res = await fetch(track.url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    this.tracks[slot] = { id: track.id, ...data };
    return this.tracks[slot];
  }

  setDelay(slot, seconds) {
    this.delays[slot] = Math.round(seconds * 1000) / 1000;
    this.onDelayChange(slot, this.delays[slot]);
  }

  setScale(slot, scale) {
    this.scales[slot] = Number(scale) > 0 ? Number(scale) : 1;
    this.onDelayChange(slot, this.delays[slot]);
  }

  nudge(slot, step) {
    this.setDelay(slot, this.delays[slot] + step);
  }

  setStyle(patch) {
    Object.assign(this.style, patch);
    this.applyStyle();
  }

  applyStyle() {
    const s = this.style;
    for (const [slot, el] of Object.entries(this.layers)) {
      el.style.fontSize = `${slot === 'secondary' ? s.size * 0.82 : s.size}vh`;
      el.style.color = slot === 'secondary' ? '#cfd6dd' : s.color;
      el.style.setProperty('--sub-bg', `rgba(0,0,0,${s.bgOpacity})`);
      el.style.textShadow = s.outline ? '0 1px 3px #000, 0 0 6px #000' : 'none';
    }
    this.layers.primary.style.bottom = `${s.bottom}%`;
    this.layers.secondary.style.top = `${Math.max(4, s.bottom * 0.9)}%`;
  }

  /**
   * Cues are sorted by start time, so the active ones are found by binary
   * searching for the first cue that starts after `t` and walking back from
   * there. Walking back matters: cues can overlap, and with a delay applied the
   * playhead can land inside several at once.
   */
  activeCues(track, t) {
    if (!track || !track.cues.length) return [];
    const cues = track.cues;
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

    for (const slot of ['primary', 'secondary']) {
      const track = this.tracks[slot];
      const el = this.layers[slot];
      if (!track) {
        if (el.dataset.shown !== '') {
          el.innerHTML = '';
          el.dataset.shown = '';
        }
        continue;
      }
      // A cue is shown at  start * scale + delay,  so going the other way —
      // from the playhead to a position in the subtitle file — undoes both.
      const t = (now - this.delays[slot]) / this.scales[slot];
      const cues = this.activeCues(track, t);
      const html = cues.map((c) => `<span class="cue">${c.text}</span>`).join('');
      if (el.dataset.shown !== html) {
        el.innerHTML = html;
        el.dataset.shown = html;
      }
    }
  }

  search(query, slot = 'primary') {
    const track = this.tracks[slot];
    if (!track || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    const out = [];
    for (const cue of track.cues) {
      const plain = decodeEntities(stripTags(cue.text)).replace(/\s+/g, ' ');
      if (plain.toLowerCase().includes(q)) {
        out.push({ time: cue.start * this.scales[slot] + this.delays[slot], text: plain });
        if (out.length >= 200) break;
      }
    }
    return out;
  }
}
