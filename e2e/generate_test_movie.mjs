import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function generate() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const dst = audioCtx.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();

    const stream = canvas.captureStream(30);
    for (const t of dst.stream.getAudioTracks()) {
      stream.addTrack(t);
    }

    let frame = 0;
    const draw = () => {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#a855f7';
      ctx.beginPath();
      ctx.arc(100 + (frame % 440), 180, 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '24px sans-serif';
      ctx.fillText(`Test Frame ${frame}`, 50, 50);
      frame++;
    };
    const interval = setInterval(draw, 1000 / 30);

    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        clearInterval(interval);
        osc.stop();
        audioCtx.close();
        const blob = new Blob(chunks, { type: 'video/webm' });
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      };
      recorder.start();
      setTimeout(() => recorder.stop(), 2000);
    });
  });

  await browser.close();
  fs.writeFileSync('e2e/test_movie.webm', Buffer.from(base64, 'base64'));
  console.log('Generated e2e/test_movie.webm, size:', fs.statSync('e2e/test_movie.webm').size);
}

generate().catch(console.error);
