# whisperai-sdk

Unofficial TypeScript SDK for [WhisperAI](https://whisperai.com/). This package provides methods and interfaces for interacting with the WhisperAI service without external runtime dependencies (except axios).

**Disclaimer:** This is an unofficial implementation and is not affiliated with WhisperAI.

## Installation

```bash
npm install whisperai
```

## Usage

### Initialization

Initialize the client with your WhisperAI credentials.

```typescript
import { WhisperClient } from 'whisperai';

const client = new WhisperClient({
  login: {
    email: "your-email@example.com",
    password: "your-password"
  },
  // Optional: Override default settings
  // whisperUrl: "https://whisperai.com",
  // chunkSize: 8 * 1024 * 1024 // 8MB
});
```

The client handles authentication automatically. It will log in on the first request and refresh the session if the token expires.

### Methods

#### User & Account

Get current user information, usage statistics, and subscription details.

```typescript
// Get user info
const userInfo = await client.user();
console.log(`User: ${userInfo.firstName} ${userInfo.lastName}`);

// Get usage stats
const usage = await client.usage();
console.log(`Monthly Usage: ${usage.monthlyUsageMinutes} minutes`);

// Get subscription details
const subscription = await client.subscriptionDetails();
```

#### Uploading Audio

Upload audio files for transcription. The `upload` method handles file chunking automatically.

```typescript
import fs from 'fs';

// Read file buffer
const buffer = fs.readFileSync('./interview.mp3');

// Upload
const result = await client.upload(buffer, {
  filename: 'interview.mp3',
  durationSeconds: 120, // Total duration in seconds
  mimeType: 'audio/mpeg', // Optional
  title: 'Interview with John Doe', // Optional
  enableSpeakerDetection: true, // Optional
  speakerCount: 'auto' // Optional: 'auto' or number
});

console.log(`Uploaded recording ID: ${result.id}`);
```

#### Transcription

Manage transcriptions for uploaded recordings.

```typescript
const recordingId = 12345;

// Start/Request transcription
const transcriptionJob = await client.transcription(recordingId);

// Check recording status and get transcription result
const recording = await client.recording(recordingId);

if (recording.status === 'completed' && recording.transcription) {
  console.log(recording.transcription.content);
  
  // Access segments with timestamps
  recording.transcription.segments.forEach(segment => {
    console.log(`[${segment.start} - ${segment.end}]: ${segment.text}`);
  });
}
```

#### Translation

Translate a recording to another language.

```typescript
const recordingId = 12345;

// Translate to Spanish
const translation = await client.translate(recordingId, 'es');
```

#### Recordings Management

List and retrieve recordings.

```typescript
// Get a specific recording by ID
const recording = await client.recording(recordingId);

// List recordings (paginated)
const recordingsList = await client.recordings({
  limit: 10,
  page: 1,
  // search: "interview", // Optional search query
  // status: "completed"  // Optional status filter
});

console.log(`Found ${recordingsList.meta.totalItems} recordings`);
```

#### Analytics

Get a summary of your activity.

```typescript
const summary = await client.summary();
console.log(`Total recordings: ${summary.recordings.total}`);
```

## Error Handling

The SDK throws specific errors for different failure scenarios.

```typescript
import { WhisperAuthError, WhisperNetworkError, WhisperApiError } from 'whisperai-sdk/errors';

try {
  await client.user();
} catch (error) {
  if (error instanceof WhisperAuthError) {
    console.error("Authentication failed. Check credentials.");
  } else if (error instanceof WhisperNetworkError) {
    console.error("Network issue.");
  } else if (error instanceof WhisperApiError) {
    console.error(`API Error ${error.status}: ${JSON.stringify(error.data)}`);
  } else {
    console.error("Unknown error:", error);
  }
}
```

## License

MIT
