const supabase = require('../supabase');

let logosBucketReady = null;

async function ensureLogosBucket() {
  if (logosBucketReady) return logosBucketReady;

  logosBucketReady = (async () => {
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    if (listError) throw listError;

    const exists = (buckets || []).some((b) => b.name === 'logos');
    if (!exists) {
      const { error: createError } = await supabase.storage.createBucket('logos', {
        public: true,
        fileSizeLimit: 2 * 1024 * 1024,
        allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
      });
      if (createError && !/already exists/i.test(createError.message)) {
        throw createError;
      }
      console.log('[Storage] Created public bucket: logos');
    }
  })();

  return logosBucketReady;
}

module.exports = { ensureLogosBucket };
