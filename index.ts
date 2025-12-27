import { readFileSync } from "node:fs";
import { WhisperClient } from "./src/client"

const clientOptions = {
    login: {
      email: "nibon74781@m3player.com",
      password: "apQwf%H%*zf!p%J8Cq5N"
    },
    whisperUrl: "https://whisperai.com"
  }

  const client = new WhisperClient(clientOptions)

  const file = readFileSync('./test/Street.m4a');


  // client.usage().then(console.log);
  // client.user().then(console.log);
  client.subscriptionDetails().then(console.log);
  // client.upload(new Uint8Array(file), {filename: 'Street.m4a', durationSeconds: 23.4}).then(console.log);
  // client.transcription(96070).then(console.log);
  // client.translate(96070, 'en').then(console.log);
  // client.summary().then(console.log);
  // client.recording(96070).then(JSON.stringify).then(console.log);
  // client.recordings().then(console.log);