import {createClient} from '@supabase/supabase-js';
import {Platform} from 'react-native';

const SUPABASE_URL = 'https://uqjlftjosdufuxivpahi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxamxmdGpvc2R1ZnV4aXZwYWhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4OTEwNzEsImV4cCI6MjEwNzQ2NzA3MX0.86EzKpe9saGUlTz0hWYkHwYiLqlmOPI2tjQEMsMHkhY';

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
