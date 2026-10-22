import 'react-native-url-polyfill/auto';
import {Platform} from 'react-native';
import {createClient} from '@supabase/supabase-js';
import {SUPABASE_URL, SUPABASE_ANON_KEY} from '@env';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

export const VOICE_MAIL_BUCKET = 'voice-mails';

export const uploadVoiceMail = async (filePath: string, fileName: string): Promise<string> => {
  const fileUri = Platform.OS === 'android' ? `file://${filePath}` : filePath;
  const response = await fetch(fileUri);
  const arrayBuffer = await response.arrayBuffer();

  const {error} = await supabase.storage
    .from(VOICE_MAIL_BUCKET)
    .upload(fileName, arrayBuffer, {
      contentType: 'audio/mp4',
      upsert: true,
    });

  if (error) throw new Error(`Upload failed: ${error.message}`);

  const {data} = supabase.storage.from(VOICE_MAIL_BUCKET).getPublicUrl(fileName);
  return data.publicUrl;
};
