/**
 * What ALP itself writes for the user, in the user's language (ALPD §54): approvals,
 * permission and trust questions, and notices. Vietnamese and English are written
 * out; any other language gets English from ALP while agents write in it.
 */

export const isVietnamese = (language: string) => /^(vi|vie|vietnamese|tiếng việt|tieng viet)$/i.test(language.trim());

const en = {
  approve: 'Approve',
  reject: 'Reject',
  answerLine: (agent: string) => `Answer Approve or Reject; any other answer goes back to ${agent} as feedback.`,
  skill: (agent: string, replacing: boolean, file: string, roles: string, lessons: string[]) =>
    `${agent} proposes a skill distilled from its lessons${replacing ? ', replacing the skill of that name' : ''}. ` +
    `Approve to save it as ${file}. Roles that get it: ${roles}.` +
    (lessons.length ? ` These lessons move into it and leave the lessons files:\n${lessons.map(lesson => `- ${lesson}`).join('\n')}` : ''),
  issue: (agent: string, create: boolean, issue: number | undefined, where: string) =>
    `${agent} wants to ${create ? `open an issue in ${where}` : `comment on issue #${issue} in ${where}`}. ` +
    'It is posted with your GitHub account, and anyone who can see the repository can read it.',
  issueTitle: 'Title',
  issueLabels: 'Labels',
  trust: (project: string, names: string) => `This project's hooks run shell commands from ${project} on your machine: ${names}. ` +
    'Trust this workspace\'s hooks? ALP asks once: after you agree, its hooks run without asking, including hooks added or changed later.',
  trustYes: 'Trust this workspace',
  trustNo: 'Not now',
  allowOnce: 'Allow once',
  alwaysAllow: 'Always allow',
  deny: 'Deny',
  permission: (agent: string, what: string, byRule: boolean, profile: string | undefined, mode: string, always: string | undefined) =>
    `${agent} wants to ${what}. ` +
    (byRule ? `Its permission profile ${profile} asks you each time.` : `Its ${mode} mode does not allow that.`) +
    (always ? ` Always allow adds ${always} to profile ${profile}.` : ''),
  limitReached: (runtime: string, resetsAt: string | undefined, other: string | undefined, autoResume: boolean, kind: string) =>
    `${runtime} usage limit reached${resetsAt ? `; it resets ${resetsAt}` : ''}. ALP paused delegation to ${runtime} agents and parked their assignments${other ? `; ${other} agents keep working` : ''}. ${autoResume && resetsAt ? 'ALP resumes it a minute after the reset.' : `Run alp resume ${kind} when it has reset.`}`,
  usageWarning: (runtime: string, used: string, resetsAt: string | undefined) => `${runtime} has used ${used} of a usage window${resetsAt ? ` that resets ${resetsAt}` : ''}.`,
  resumed: (what: string, by: string, parked: boolean) => `${what} resumed by ${by}.${parked ? ' Parked assignments continue.' : ''}`,
  paused: (what: string, reason: string | undefined, runtime: string | undefined, now: boolean) =>
    `${what} paused by the user${reason ? `: ${reason}` : ''}. Delegation${runtime ? ` to ${runtime} agents` : ''} waits${now ? ', and running assignments park where they are' : '; running turns finish'}. alp resume continues.`,
};

export type Words = typeof en;

/** ALP's permission requests start with an English verb; these are the ones it writes. */
const viWhat = (what: string) => what.replace(/^run /, 'chạy ').replace(/^change files under /, 'sửa file trong ').replace(/^change files/, 'sửa file').replace(/^use /, 'dùng ');

const vi: Words = {
  approve: 'Duyệt',
  reject: 'Từ chối',
  answerLine: agent => `Chọn Duyệt hoặc Từ chối; câu trả lời khác sẽ được gửi lại cho ${agent} làm góp ý.`,
  skill: (agent, replacing, file, roles, lessons) =>
    `${agent} đề xuất một skill đúc kết từ các bài học${replacing ? ', thay cho skill cùng tên' : ''}. ` +
    `Duyệt để lưu thành ${file}. Các vai được dùng: ${roles}.` +
    (lessons.length ? ` Các bài học sau chuyển vào skill và rời khỏi file bài học:\n${lessons.map(lesson => `- ${lesson}`).join('\n')}` : ''),
  issue: (agent, create, issue, where) =>
    `${agent} muốn ${create ? `mở một issue trong ${where}` : `bình luận vào issue #${issue} trong ${where}`}. ` +
    'Nội dung được đăng bằng tài khoản GitHub của bạn, ai xem được repository đều đọc được.',
  issueTitle: 'Tiêu đề',
  issueLabels: 'Nhãn',
  trust: (project, names) => `Các hook của project này chạy lệnh shell từ ${project} trên máy của bạn: ${names}. ` +
    'Tin cậy các hook của workspace này? ALP chỉ hỏi một lần: khi bạn đồng ý, các hook chạy mà không hỏi lại, kể cả hook thêm hoặc sửa sau này.',
  trustYes: 'Tin cậy workspace này',
  trustNo: 'Để sau',
  allowOnce: 'Cho phép lần này',
  alwaysAllow: 'Luôn cho phép',
  deny: 'Từ chối',
  permission: (agent, what, byRule, profile, mode, always) =>
    `${agent} muốn ${viWhat(what)}. ` +
    (byRule ? `Hồ sơ quyền ${profile} của nó yêu cầu hỏi bạn mỗi lần.` : `Chế độ ${mode} của nó không cho phép việc này.`) +
    (always ? ` Luôn cho phép sẽ thêm ${always} vào hồ sơ ${profile}.` : ''),
  limitReached: (runtime, resetsAt, other, autoResume, kind) =>
    `${runtime} đã hết hạn mức sử dụng${resetsAt ? `; hạn mức đặt lại lúc ${resetsAt}` : ''}. ALP tạm dừng giao việc cho các agent ${runtime} và tạm giữ việc của chúng${other ? `; các agent ${other} vẫn làm tiếp` : ''}. ${autoResume && resetsAt ? 'ALP tự chạy lại một phút sau khi đặt lại.' : `Chạy alp resume ${kind} khi hạn mức đã đặt lại.`}`,
  usageWarning: (runtime, used, resetsAt) => `${runtime} đã dùng ${used} hạn mức của kỳ này${resetsAt ? `, kỳ đặt lại lúc ${resetsAt}` : ''}.`,
  resumed: (what, by, parked) => `${what} đã chạy lại, bởi ${by}.${parked ? ' Các việc đang tạm giữ được làm tiếp.' : ''}`,
  paused: (what, reason, runtime, now) =>
    `${what} đã bị người dùng tạm dừng${reason ? `: ${reason}` : ''}. Việc giao${runtime ? ` cho các agent ${runtime}` : ''} phải chờ${now ? ', các việc đang chạy được tạm giữ tại chỗ' : '; các lượt đang chạy vẫn chạy hết'}. Chạy alp resume để tiếp tục.`,
};

export function words(language: string): Words {
  return isVietnamese(language) ? vi : en;
}

/** Every label a choice may be answered with, in any language ALP writes. */
export const CHOICES = {
  trust: [en.trustYes, vi.trustYes].map(label => label.toLowerCase()),
  allowOnce: [en.allowOnce, vi.allowOnce].map(label => label.toLowerCase()),
  alwaysAllow: [en.alwaysAllow, vi.alwaysAllow].map(label => label.toLowerCase()),
  deny: [en.deny, vi.deny].map(label => label.toLowerCase()),
};

/** The line every agent reads about the user's language. */
export function languageInstruction(language: string, agent: string, main: boolean) {
  return main
    ? `The user reads ${language}. Write in ${language} everything the user reads: your replies, questions you ask with alp_ask (and their options), approval requests and what you say about them, gate notes, and the titles and descriptions of tasks you create. Briefs, handoffs and mail between agents may use any language. GitHub issues and comments follow the repository's language; tell the user about them in ${language}.`
    : agent === 'supervisor'
      ? `The user reads ${language}: main must write everything the user reads in ${language}.`
      : `The user reads ${language}. A question you put to the user with alp_ask, and its options, must be in ${language}; briefs, handoffs and mail between agents may use any language.`;
}
