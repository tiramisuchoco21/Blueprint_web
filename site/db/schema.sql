-- ============================================================================
-- 청사진(CheongSaJin) · Supabase 스키마
-- 실행: Supabase 프로젝트 > SQL Editor 에 붙여넣고 실행
-- 인증은 Supabase Auth(auth.users)를 그대로 사용하고, 프로필만 확장한다.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 프로필 : 회원가입 시 받는 "정책 판정에 필요한 값"
--    컬럼명 뒤 주석의 코드는 온통청년 API 코드체계(API코드정보.xlsx)와 1:1 대응
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  nickname        text not null,
  birth_ymd       date not null,                       -- 만 나이 계산용
  annual_income   bigint      not null default 0,      -- 세전 연소득(원) → earnMaxAmt 비교
  net_asset       bigint,                               -- 순자산(원). 버팀목 3.45억 등 자산요건 자동판정용
  job_code        text        not null default '0013001',  -- jobCd    (0013001 재직자 …)
  school_code     text        not null default '0049010',  -- schoolCd (0049010 제한없음 …)
  major_code      text        not null default '0011009',  -- plcyMajorCd
  marriage_code   text        not null default '0055002',  -- mrgSttsCd (0055001 기혼/0055002 미혼)
  sbiz_codes      text[]      not null default '{}',       -- sBizCd (0014001 중소기업 등, 복수)
  zip_cd          text        not null,                 -- 법정시군구코드 5자리 (11440 마포구)
  region_name     text,                                 -- 표시용 (서울특별시 마포구)
  is_homeowner    boolean     not null default false,   -- 무주택 여부(false = 무주택)
  household_size  int         not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. 목표 : "2년 뒤 마포구 1억 전세 독립"
--    다음 접속 시 status='active' 목표가 있으면 곧바로 대시보드로 보낸다.
-- ---------------------------------------------------------------------------
create table if not exists public.goals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  raw_input       text,                                 -- 사용자가 실제로 친 자연어 원문
  goal_type       text not null,                        -- jeonse | purchase | fund | wedding
  target_amount   bigint not null,                      -- 목표 금액(원) 100,000,000
  target_months   int    not null,                      -- 목표 기간(개월) 24
  target_zip_cd   text,                                 -- 목표 지역
  current_asset   bigint not null default 0,            -- 현재 보유 금융자산(원)
  monthly_saving  bigint not null default 0,            -- 확정 월 저축액(원)
  status          text   not null default 'active',     -- active | achieved | archived
  started_on      date   not null default current_date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists goals_user_active_idx on public.goals(user_id, status);

-- ---------------------------------------------------------------------------
-- 3. 목표-정책 선택 : STEP 1 중복 선택 → STEP 3 최종 확정
--    is_final = true 인 행이 "확정된 조합"
-- ---------------------------------------------------------------------------
create table if not exists public.goal_policies (
  id              uuid primary key default gen_random_uuid(),
  goal_id         uuid not null references public.goals(id) on delete cascade,
  policy_id       text not null,                        -- policies.json 의 policy_id
  verdict         text not null,                        -- eligible | conditional | not_eligible | ended
  applied_amount  bigint not null default 0,            -- 이 정책으로 계산된 활용 예상액(원)
  is_final        boolean not null default false,
  selected_at     timestamptz not null default now(),
  unique (goal_id, policy_id)
);

-- ---------------------------------------------------------------------------
-- 4. 시뮬레이션 이력 : STEP 3 슬라이더 조작 결과
-- ---------------------------------------------------------------------------
create table if not exists public.simulations (
  id              uuid primary key default gen_random_uuid(),
  goal_id         uuid not null references public.goals(id) on delete cascade,
  monthly_saving  bigint not null,
  months_needed   int    not null,
  gap_months      int    not null,                      -- 목표 대비 (+ 지연 / - 단축)
  plan            text   not null default 'A',          -- A(기간 유지) | B(부담 완화)
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. 결제 내역 : STEP 4 (상시 입력 가능)
-- ---------------------------------------------------------------------------
create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  occurred_at     timestamptz not null,
  merchant_raw    text   not null,                      -- 원문 상호 ("NICE결제대행-(주)쏘카")
  merchant_norm   text,                                 -- 정규화 상호 ("쏘카")
  amount          bigint not null,
  category        text   not null default 'unknown',    -- 아래 fintox.js 의 카테고리
  category_source text   not null default 'rule',       -- rule | user | unknown
  source          text   not null default 'manual',     -- manual | paste | dummy
  created_at      timestamptz not null default now()
);
create index if not exists tx_user_time_idx on public.transactions(user_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 6. FinTox 점수 : 규칙별 배점을 그대로 저장해 "왜 이 점수인지" 재현 가능하게
-- ---------------------------------------------------------------------------
create table if not exists public.fintox_scores (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references public.transactions(id) on delete cascade,
  score           int  not null,                        -- 0~100
  level           text not null,                        -- safe | watch | caution
  breakdown       jsonb not null,                       -- {outlier:.., goal_share:.., repeat:.., night:..}
  goal_share_pct  numeric(6,2),                         -- 월 저축목표 대비 %
  created_at      timestamptz not null default now(),
  unique (transaction_id)
);

-- ---------------------------------------------------------------------------
-- 7. 실행 체크리스트 : STEP 5 준비도(Financial Readiness)
-- ---------------------------------------------------------------------------
create table if not exists public.checklist_items (
  id              uuid primary key default gen_random_uuid(),
  goal_id         uuid not null references public.goals(id) on delete cascade,
  item_key        text not null,                        -- goal_set | finance_input | eligibility …
  label           text not null,
  is_done         boolean not null default false,
  done_at         timestamptz,
  unique (goal_id, item_key)
);

-- ---------------------------------------------------------------------------
-- 8. 정책 스냅샷 : 판정 당시의 정책 원문을 그대로 보관 (Trust Architecture)
--    정책이 바뀌어도 "그때 무엇을 근거로 판정했는지" 남는다.
-- ---------------------------------------------------------------------------
create table if not exists public.policy_snapshots (
  id              uuid primary key default gen_random_uuid(),
  policy_id       text not null,
  plcy_no         text,                                 -- 온통청년 plcyNo
  payload         jsonb not null,                       -- API 응답 원문 or 정형 DB 레코드
  source_name     text,
  source_url      text,
  based_on        date,                                 -- 기준일 (lastMdfcnDt)
  fetched_at      timestamptz not null default now()
);
create index if not exists snapshot_policy_idx on public.policy_snapshots(policy_id, fetched_at desc);

-- ============================================================================
-- RLS : 본인 데이터만 접근
-- ============================================================================
alter table public.profiles        enable row level security;
alter table public.goals           enable row level security;
alter table public.goal_policies   enable row level security;
alter table public.simulations     enable row level security;
alter table public.transactions    enable row level security;
alter table public.fintox_scores   enable row level security;
alter table public.checklist_items enable row level security;
alter table public.policy_snapshots enable row level security;

create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create policy "own goals" on public.goals
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own transactions" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 목표에 종속된 테이블은 goals 를 통해 소유권 확인
create policy "own goal policies" on public.goal_policies
  for all using (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()))
  with check (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()));

create policy "own simulations" on public.simulations
  for all using (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()))
  with check (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()));

create policy "own checklist" on public.checklist_items
  for all using (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()))
  with check (exists (select 1 from public.goals g where g.id = goal_id and g.user_id = auth.uid()));

create policy "own fintox" on public.fintox_scores
  for all using (exists (select 1 from public.transactions t where t.id = transaction_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.transactions t where t.id = transaction_id and t.user_id = auth.uid()));

-- 정책 스냅샷은 모든 로그인 사용자가 읽을 수 있고, 쓰기는 서버(service_role)만
create policy "read snapshots" on public.policy_snapshots
  for select using (auth.role() = 'authenticated');

-- ============================================================================
-- 가입 시 프로필 자동 생성 트리거
-- (auth.users 에 행이 생기면 raw_user_meta_data 로 profiles 를 채운다)
-- ============================================================================
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, nickname, birth_ymd, annual_income, job_code,
                               school_code, major_code, marriage_code, zip_cd,
                               region_name, is_homeowner)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nickname', '사용자'),
    coalesce((new.raw_user_meta_data->>'birth_ymd')::date, '2000-01-01'),
    coalesce((new.raw_user_meta_data->>'annual_income')::bigint, 0),
    coalesce(new.raw_user_meta_data->>'job_code', '0013001'),
    coalesce(new.raw_user_meta_data->>'school_code', '0049010'),
    coalesce(new.raw_user_meta_data->>'major_code', '0011009'),
    coalesce(new.raw_user_meta_data->>'marriage_code', '0055002'),
    coalesce(new.raw_user_meta_data->>'zip_cd', '11000'),
    new.raw_user_meta_data->>'region_name',
    coalesce((new.raw_user_meta_data->>'is_homeowner')::boolean, false)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
