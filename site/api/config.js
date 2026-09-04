/* 프론트에 내려도 되는 공개 설정만 반환한다.
 * (Supabase anon key 는 공개 키이며 RLS 로 보호된다. 서비스 키·AI 키는 절대 내려보내지 않는다.) */
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    hasAI: !!process.env.ANTHROPIC_API_KEY,
    hasPolicyApi: !!process.env.YOUTH_API_KEY,
    policyDbBasedOn: process.env.POLICY_DB_BASED_ON || null,
  });
}
