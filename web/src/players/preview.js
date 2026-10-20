// iTunes 30-second previews in an <audio> element. The previewUrl comes from the server's own
// iTunes lookup (never from a student's page), so the host can play it as it is. Songs from
// Spotify's catalog have none (and may not be looked up elsewhere: Spotify's Developer Policy),
// so canPlay is false for them and the host page skips them.

export function createPreviewPlayer() {
  const audio = new Audio();
  audio.preload = 'auto';
  let ended = () => {}, failed = () => {}, time = () => {};
  let loaded = false;

  audio.addEventListener('ended', () => ended());
  audio.addEventListener('timeupdate', () => time(audio.currentTime, audio.duration || 30));
  audio.addEventListener('error', () => { if (loaded) failed('This song preview would not load.'); });

  return {
    name: '30-second previews',
    canPlay: (song) => Boolean(song?.previewUrl),
    async load(song) {
      loaded = true;
      audio.src = song.previewUrl;
      audio.currentTime = 0;
      time(0, 30);
    },
    play: () => audio.play(),
    pause: () => audio.pause(),
    stop() {
      loaded = false;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      time(0, 30);
    },
    setVolume(v) { audio.volume = Math.min(1, Math.max(0, v)); },
    onEnded(fn) { ended = fn; },
    onError(fn) { failed = fn; },
    onTime(fn) { time = fn; },
  };
}
