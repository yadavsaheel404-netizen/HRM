-- Documents live under employee-documents/<user_id>/<doc_type>/<file>
CREATE POLICY "docs own read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'employee-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "docs own write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'employee-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "docs own delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'employee-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "docs verifier read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'employee-documents' AND public.has_permission(auth.uid(), 'documents:read:all'));

CREATE POLICY "avatar own read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatar org read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND public.has_permission(auth.uid(), 'workforce:read:all'));
CREATE POLICY "avatar own write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatar own update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);