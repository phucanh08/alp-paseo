# Kết quả Giai đoạn 2 → 5

Ngày: 2026-10-06. Thực hiện tuần tự; không đọc Giai đoạn 6 trở đi. Workspace đầu vào chưa có triển khai Giai đoạn 1, chỉ có kế hoạch và báo cáo Giai đoạn 0. Đã thêm package JavaScript tối thiểu và tests để thực hiện Giai đoạn 2; không đọc kế hoạch Giai đoạn 1 hoặc tự triển khai `alp init`.

## Giai đoạn 2 — Config, discovery, resolution

- Tệp tạo: `package.json`, `src/core/resolver.js`, `test/resolver.test.js`.
- Đọc duy nhất kế hoạch `02-resolver.md` tại giai đoạn này; dùng lại quyết định D1–D10 đã đọc ở Giai đoạn 0.
- Resolver đọc settings, ALP.md, AGENT.md, phát hiện agent/skills/hooks/MCP từ filesystem và trả lỗi rõ nguồn. Không khởi chạy runtime, không nạp skill body.
- Thứ tự chọn: explicit agent → defaultAgent → main. Agent đã chọn nhưng thiếu không tự rơi về main.
- Kiểm tra tại mốc chuyển: **10/10 tests**, kiểm tra cú pháp qua.
- Nghiệm thu: **đạt**; discovery không cần đăng ký trung tâm, không có import provider. Không có blocker còn lại.

## Giai đoạn 3 — ResolvedAgent IR

- Đọc `03-ir.md` rồi `reference/IR.md` theo yêu cầu cụ thể.
- Tệp tạo: `src/core/types.d.ts`, `errors.js`, `validation.js`, `test/ir.test.js`; cập nhật resolver và tests.
- Tách cấu hình thô khỏi IR; đường dẫn tài nguyên/cwd MCP được chuẩn hóa; giữ runtime dưới dạng chuỗi trung lập provider. Schema kiểm tra runtime và transport MCP, serialize/deserialize được.
- Kiểm tra tại mốc chuyển: **14/14 tests**, gồm fake consumer không biết provider.
- Nghiệm thu: **đạt**. Không thêm team graphs, scheduler, child-agent hay ACP message. Không có blocker còn lại.

## Giai đoạn 4 — Adapter boundary

- Đọc `04-adapters.md`; không mở tham chiếu ngoài yêu cầu.
- Tệp tạo: `src/core/adapter.js`, `adapter.d.ts`, `src/adapters/fake.js`, `test/adapter.test.js`, `docs/alp/adapter-boundary.md`.
- Contract chỉ có id/capabilities/compile, không có lifecycle. Capabilities có native/emulated/unsupported; không âm thầm bỏ tài nguyên bắt buộc. Compiler nhận bản sao IR.
- Kiểm tra tại mốc chuyển: **16/16 tests**, fake adapter compile main và custom; kiểm tra import boundary.
- Nghiệm thu: **đạt**; core chỉ dùng Node builtins và module core. Các tests core chạy riêng không cần cài Paseo. Không có blocker còn lại.

## Giai đoạn 5 — Paseo plugin

- Đọc `05-paseo-plugin.md`; khảo sát public SDK/tài liệu Paseo và giao thức runtime cần cho phiên thật. Không đọc kế hoạch giai đoạn tương lai.
- Tệp tạo: package/manifest/entry của `plugins/paseo`; `server/compat.ts`, `mapping.ts`, `provider.ts`, `transport.ts`, `index.ts`; `tsconfig.paseo.json`; scripts build, host E2E và runtime E2E; tests Paseo/transport; README và tài liệu nghiệm thu. Cập nhật package/lockfile, declaration compileAgent và validation; thêm `.gitignore`, `.npmrc`.
- Đăng ký trực tiếp public `ProviderRegistration`. Core vẫn không nhập Paseo/Codex. User chọn model `gpt-5.6-sol`; Codex chỉ là runtime nằm bên trong plugin Paseo cho prototype này.
- SDK phát triển pin **0.9.2**. Đã build/typecheck và chạy plugin trên daemon riêng **0.9.2** và **0.10.3**, dùng **Codex CLI 0.160.1**.
- Thực tế phiên bản máy: Windows có **Paseo Desktop 0.9.2**; lệnh CLI trong PATH trỏ tới **0.7.2**, ngoài ra có package CLI cũ 0.5.1. Các daemon kiểm thử có home riêng trong workspace; không thay bản Desktop hoặc cấu hình người dùng.

| Tiêu chí prototype | Bằng chứng | Trạng thái |
|---|---|---|
| Paseo khám phá/chọn provider ALP | Plugin status running; public catalog hiển thị GPT-5.6 Sol; tạo phiên qua SDK | Đạt |
| Tạo phiên trong project thật | Fixture chứa ALP.md, settings và agent folders trên filesystem; model inference qua daemon thật | Đạt |
| main mặc định | Tạo phiên không truyền agent; phản hồi `PROJECT_ORCHID AGENT_MAIN` | Đạt |
| Kết hợp ngữ nghĩa project + agent | Hai token chỉ có trong hai tệp instructions khác nhau; model trả đúng cả hai | Đạt |
| Custom agent không sửa core | Truyền options.agent=custom; phản hồi `PROJECT_ORCHID AGENT_CUSTOM` | Đạt |
| Close/reload không làm hỏng tệp | CLI reload phiên, inference lại đúng; snapshot toàn bộ fixture trước/sau giống nhau | Đạt |

Các kiểm tra mapping bao phủ cwd, instructions, env, MCP, model/mode/thinking, persistence identity và lỗi unsupported. Tests protocol dùng schema SDK thật, kiểm tra dedup prompt, complete snapshots, early completion, failed open cleanup. Runtime thật kiểm tra steering, cancel và close đều qua. Không chỉ dựa vào mock để kết luận phiên/model hoạt động.

Giới hạn prototype được ghi tại `paseo-plugin.md`: hooks và interactive permissions chưa hỗ trợ, timeline native mới bao phủ text/shell, chưa kiểm tra UI Desktop trực quan hoặc lịch sử rất lớn. Không có blocker đối với các tiêu chí prototype Giai đoạn 5. Không có thiếu sót extension point đòi hỏi fork Paseo.

## Lệnh xác minh cuối

```sh
node node_modules/typescript/bin/tsc -p tsconfig.paseo.json
node scripts/build-paseo.mjs
node --test
node --test test/resolver.test.js test/ir.test.js test/adapter.test.js
node scripts/paseo-e2e.mjs
node scripts/runtime-e2e.mjs
```

Hai lệnh E2E là opt-in, có yêu cầu daemon/runtime thực theo hướng dẫn. Các bài test mặc định không gọi model. Bằng chứng chạy cục bộ lưu trong `.alp-test/phase-5-e2e.json` và `.alp-test/runtime-e2e.json`; thư mục này không thuộc source phát hành.

Kết quả cuối: **24/24 tests qua, typecheck qua, build qua**. E2E main/custom/reload qua trên cả hai phiên bản Paseo; steering/cancel/close qua với runtime thật. Đã dừng các daemon kiểm thử riêng sau khi xác minh.

**Kết luận: Giai đoạn 2, 3, 4 và 5 đạt tiêu chí nghiệm thu tương ứng. Dừng tại Giai đoạn 5.**
