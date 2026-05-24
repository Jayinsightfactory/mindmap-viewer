param(
  [string]$BaseUrl = "http://localhost:3000",
  [string]$EmployeeName = "Sul Yeonju",
  [string]$AccountId = "nenova:sales-support:sul-yeonju"
)

$payload = @{
  id = "WU-PC-20260524-SAMPLE"
  type = "mouse.chunk"
  employeeName = $EmployeeName
  employeeId = "sul-yeonju"
  accountId = $AccountId
  team = "sales-support"
  workArea = "quote/customer-price"
  source = "nenova.exe"
  appName = "nenova.exe"
  windowTitle = "Quote Management - Customer Price"
  clickCount = 34
  clickEvidence = @("customer search", "add item row", "input supply price", "save quote")
  category = "quote"
  title = "API sample Daehan quote price input"
  detail = "Sample event: a Kakao request was followed by quote price input in nenova.exe."
  customer = "Daehan Trading"
  projectId = "PRJ-20260524-SAMPLE"
  taskId = "TSK-20260524-SAMPLE"
  startedAt = "2026-05-24T09:10:00+09:00"
  endedAt = "2026-05-24T09:32:00+09:00"
  confidence = 88
  pcEvidence = @("active_app=nenova.exe", "window_title=Quote Management", "mouse_clicks=34")
  relatedTalks = @(
    @{
      source = "KakaoTalk"
      room = "Daehan Trading"
      sender = "Customer Manager"
      sentAt = "2026-05-24T09:07:00+09:00"
      text = "Can we receive the June price table today?"
      intent = "quote_request"
      relation = "talk_before_work"
    }
  )
}

$json = $payload | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/work-units" -ContentType "application/json; charset=utf-8" -Body $json
