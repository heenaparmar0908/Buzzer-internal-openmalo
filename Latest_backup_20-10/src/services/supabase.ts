import {Platform} from 'react-native';
import {SUPABASE_URL, SUPABASE_ANON_KEY} from '@env';

export const VOICE_MAIL_BUCKET = 'voice-mails';

export const uploadVoiceMail = async (filePath: string, fileName: string): Promise<string> => {
  // Read local file as blob using fetch
  const fileUri = Platform.OS === 'android' ? `file://${filePath}` : filePath;
  const response = await fetch(fileUri);
  const blob = await response.blob();

  // Upload directly to Supabase Storage via REST API
  const uploadResponse = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${VOICE_MAIL_BUCKET}/${fileName}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'audio/mp4',
        'x-upsert': 'true',
      },
      body: blob,
    },
  );

  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text();
    throw new Error(`Upload failed (${uploadResponse.status}): ${errText}`);
  }

  // Return public URL
  return `${SUPABASE_URL}/storage/v1/object/public/${VOICE_MAIL_BUCKET}/${fileName}`;
};
