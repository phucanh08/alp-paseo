# Giai đoạn 0 — Khảo sát repository và baseline

Ngày khảo sát: 2026-10-06. Phạm vi: `D:\Projects\alp-workspace`.

## Kết quả chính

Workspace ban đầu chỉ có thư mục `plans/`, chưa có mã nguồn, package ứng dụng hay bộ kiểm thử. `git status --short` trả về `fatal: not a git repository (or any of the parent directories): .git`. Vì vậy đây là baseline của một workspace chứa kế hoạch, chưa phải codebase ALP đang hoạt động.

Đã đọc theo thứ tự `plans/AGENTS.md`, `plans/PLAN.md`, `plans/phases/00-foundation.md`, rồi `plans/reference/DECISIONS.md`; đọc thêm `plans/README.md` để xác định bản chất workspace. Không đọc các tệp giai đoạn sau, `reference/TARGET_LAYOUT.md` hay `reference/IR.md`.

## Bản đồ liên quan đến ALP

| Đường dẫn | Vai trò và hiện trạng |
|---|---|
| `plans/AGENTS.md` | Quy tắc thực thi tuần tự, giới hạn đọc và ranh giới provider |
| `plans/PLAN.md` | Roadmap và phạm vi v0 |
| `plans/README.md` | Giới thiệu bộ kế hoạch; lệnh `codex` là hướng dẫn khởi động công cụ, không phải CLI ALP |
| `plans/phases/00-foundation.md` | Yêu cầu khảo sát và báo cáo hiện tại |
| `plans/phases/` | Kế hoạch từng giai đoạn; nội dung các giai đoạn sau chưa được khảo sát |
| `plans/reference/DECISIONS.md` | Quyết định kiến trúc D1–D10 |
| `plans/reference/` | Các tham chiếu khác chưa đọc theo quy tắc progressive disclosure |
| `docs/alp/phase-0-findings.md` | Báo cáo mới duy nhất của giai đoạn này |

## Công nghệ, build, test và cấu hình

| Hạng mục | Baseline quan sát được |
|---|---|
| Package manager | Chưa xác định: không có manifest hay lockfile ứng dụng |
| Ngôn ngữ triển khai | Chưa có mã nguồn; các tệp đã khảo sát là Markdown |
| Build scripts và CI | Chưa có; không có lệnh build hiện hữu để chạy |
| Tests và test runner | Chưa có; không có lệnh test hiện hữu để chạy |
| CLI entrypoint | Chưa có; `alp init` chỉ được nhắc đến như hành vi dự kiến trong D3 |
| Config ứng dụng | Chưa có `ALP.md`, `.alp/settings.json` hay `.alp/agents/`; đây là quy ước dự kiến theo D1–D6 |
| Git | Workspace chưa phải Git repository |

Không suy đoán các lệnh như `npm test` hoặc chọn package manager khi chưa có căn cứ. Lệnh build/test cần được xác lập khi scaffold được triển khai ở giai đoạn thích hợp.

## Tham chiếu hiện hữu

Tìm kiếm không phân biệt hoa/thường các từ `ALP`, `Paseo`, `ACP`, `Claude`, `Codex`, `agent`, `skill`, `hook`, `MCP` trong phạm vi tài liệu được phép đọc cho thấy:

- ALP chỉ tồn tại dưới dạng kế hoạch và quyết định; chưa có implementation để tái sử dụng.
- Paseo được chọn làm runtime host đầu tiên (D8); chưa có plugin, SDK hay adapter trong workspace.
- Claude/Codex/Paseo/ACP là các tích hợp bên ngoài core (D7); ACP được hoãn đến khi mô hình ổn định (D9).
- Agent duy nhất có sẵn là `main` theo thiết kế (D3). Agent tự chứa `AGENT.md`, `skills/`, `hooks/`, `.mcp.json` (D4), được phát hiện qua filesystem (D5).
- Skills và kế hoạch được nạp theo nhu cầu (D10); chưa có skill body, hook thực thi hay cấu hình MCP ứng dụng.

Không tìm kiếm nội dung tài liệu tương lai để tránh tải trước ngoài phạm vi.

## Vị trí core đề xuất

Đề xuất sơ bộ dùng một module `src/core/` trong một package gốc duy nhất. Đây là vị trí nhỏ nhất hợp lý khi chưa có package/module hiện hữu: không cần dựng monorepo, workspace manager hoặc package xuất bản riêng chỉ để bắt đầu ALP.

Module này dành cho ngữ nghĩa ALP trung lập provider; không nhập SDK/type của Paseo, Claude, Codex hoặc ACP. CLI và adapter sẽ dùng core qua ranh giới riêng khi đến giai đoạn tương ứng. `.alp/` chứa cấu hình và agent của dự án người dùng, không phải mã nguồn core; `plans/` tiếp tục chỉ chứa tài liệu kế hoạch.

Đây là đề xuất, chưa tạo thư mục hoặc quyết định ngôn ngữ. Khi Giai đoạn 1 cho phép đọc layout đích, cần đối chiếu yêu cầu đó trước khi chốt đường dẫn; đề xuất này không thay thế tài liệu chưa được đọc.

## Xung đột với quyết định D1–D10

Chưa phát hiện xung đột giữa các tài liệu đã đọc và `DECISIONS.md`. Do chưa có implementation, chưa thể xác nhận tuân thủ kiến trúc bằng kiểm thử.

`plans/AGENTS.md` là hướng dẫn cho tác nhân triển khai, không thay thế `ALP.md` của dự án theo D1. Việc chưa có `.alp/` là thiếu scaffold, không phải một quy ước cấu hình cạnh tranh. Không thay đổi kiến trúc hoặc thêm fixture trong giai đoạn này.

## Rủi ro và blocker

- Chưa có mã nguồn để khảo sát khả năng tương thích hoặc baseline chạy được. Nếu người dùng kỳ vọng khảo sát một codebase có sẵn thì workspace hiện tại chưa chứa codebase đó; không tự tìm hoặc clone repository ngoài phạm vi.
- Chưa có toolchain, build/test commands hay dependency versions; phải xác lập khi bắt đầu triển khai. Đây là giới hạn baseline, không cản trở việc hoàn thành báo cáo Giai đoạn 0.
- Chưa có Git nên không thể dùng diff/status để theo dõi baseline; không tự khởi tạo Git trong nhiệm vụ khảo sát.
- Chưa kiểm chứng plugin boundary thực tế của Paseo. D8 được ghi nhận là quyết định dự án, không phải kết luận đã xác minh về API bên ngoài.
- Vị trí core và danh sách tệp sau đây còn phụ thuộc yêu cầu Giai đoạn 1 chưa được đọc.

## Các tệp có khả năng thay đổi trong Giai đoạn 1

Danh sách dự kiến chỉ dựa trên roadmap và D1–D6, không phải phạm vi triển khai đã chốt:

- Manifest, cấu hình build/test và entrypoint của package gốc: tên cụ thể tùy toolchain được chọn.
- `src/core/`: scaffold core nếu phù hợp layout được phép đọc ở giai đoạn tiếp theo.
- `ALP.md`, `.alp/settings.json`, `.alp/agents/main/AGENT.md`: scaffold hoặc fixture/template tương ứng cho cấu trúc dự án ALP.
- `.alp/agents/main/skills/`, `.alp/agents/main/hooks/`, `.alp/agents/main/.mcp.json`: thành phần agent theo D4, tùy yêu cầu scaffold.
- Tài liệu chạy dự án và kiểm thử scaffold theo yêu cầu thực tế.

Không dự kiến triển khai resolver, adapter hoặc runtime trong Giai đoạn 0.

## Kiểm tra và tiêu chí chấp nhận

Các kiểm tra đã thực hiện: liệt kê root kể cả mục ẩn bằng `Get-ChildItem -Force`; kiểm tra hướng dẫn `AGENTS.md` ở root (không có); liệt kê tệp bằng `rg --files --hidden` với loại trừ các phase và tham chiếu chưa được phép đọc; tìm tham chiếu bằng `rg -n -i` trong các tài liệu hiện tại; chạy `git status --short` (không thành công do không có Git repository).

Không chạy build hay tests vì chưa tồn tại manifest, scripts hoặc test suite. Không thêm kiểm thử cho thay đổi chỉ gồm báo cáo.

| Tiêu chí | Trạng thái |
|---|---|
| Biết các lệnh build/test hiện hữu | Đã xác định không có lệnh hiện hữu; baseline thực thi chưa khả dụng |
| Vị trí tích hợp ALP được giải thích | Đạt ở mức đề xuất khảo sát: một module core trong package gốc, chờ đối chiếu layout Giai đoạn 1 |
| Chưa đưa thiết kế provider vào core | Đạt: không tạo hoặc sửa mã core, không thêm dependency |

Giai đoạn 0 hoàn tất với giới hạn baseline nêu trên. Dừng tại báo cáo này và chờ người dùng yêu cầu Giai đoạn 1.
