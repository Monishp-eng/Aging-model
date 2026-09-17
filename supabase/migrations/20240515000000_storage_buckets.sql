-- Supabase Storage Configuration as Code
-- Declares private input, output, and temp buckets and establishes storage RLS policies

-- 1. Create or update storage buckets with private access and size/MIME constraints
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
    ('input', 'input', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
    ('output', 'output', false, 10485760, ARRAY['image/gif', 'image/webp', 'image/jpeg', 'image/png'])
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/gif', 'image/webp', 'image/jpeg', 'image/png'];

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
    ('temp', 'temp', false, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE SET
    public = false,
    file_size_limit = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

-- 2. Storage Objects Row Level Security (RLS)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Deny public/anon direct access to input and output buckets
DROP POLICY IF EXISTS "Public Access Denied" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Users Can Read Own Objects" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated Users Can Upload Own Objects" ON storage.objects;

-- Allow authenticated users to view only their own objects in their namespace: {userId}/*
CREATE POLICY "Authenticated Users Can Read Own Objects" ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id IN ('input', 'output')
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Allow authenticated users to upload to their own namespace: {userId}/*
CREATE POLICY "Authenticated Users Can Upload Own Objects" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'input'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );
