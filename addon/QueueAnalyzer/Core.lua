-- Core.lua
-- Reads every current applicant to your posted Group Finder listing (you
-- must be the group leader with an active listing that has applicants --
-- this is the Premade Groups applicant queue, not the anonymous automatic
-- Dungeon Finder matchmaking queue, which never exposes names at all).
--
-- C_LFGList.GetApplicants() returns every applicant ID for your listing in
-- one call (confirmed against Blizzard's own LFGListApplicationViewer
-- update code) -- no need to hover or scroll through the UI. The raw order
-- it comes back in does NOT match the on-screen applicant list order
-- (confirmed live) -- Blizzard itself re-sorts it before display via
-- LFGListUtil_SortApplicants (new applications to the bottom, otherwise by
-- applicantInfo.displayOrderID), so we call that exact same function on our
-- own copy before reading names, to match what you see in the window.

BINDING_HEADER_QUEUEANALYZER = "Queue Analyzer"
BINDING_NAME_QUEUEANALYZER_TOGGLE = "Show/export applicant names"

---Collect "Name-Realm" for every member of every current applicant.
---@return string[] names
local function GetApplicantNames()
	local names = {}

	local applicants = C_LFGList.GetApplicants()
	if LFGListUtil_SortApplicants then
		LFGListUtil_SortApplicants(applicants)
	end
	for _, applicantID in ipairs(applicants) do
		local info = C_LFGList.GetApplicantInfo(applicantID)
		if info then
			for memberIdx = 1, info.numMembers do
				local fullName = C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
				if fullName then
					local name, realm = strsplit("-", fullName)
					if not realm or realm == "" then
						realm = GetNormalizedRealmName()
					end
					table.insert(names, name .. "-" .. realm)
				end
			end
		end
	end

	return names
end

-- Data imported from the webapp (pasted into the import window below), keyed
-- by the same "Name-Realm" string GetApplicantNames() produces, valued by
-- the WCL "Best" percentile. Session-only (no SavedVariables) -- re-paste
-- after each /reload, matching the export side which is also always
-- re-read live.
QueueAnalyzerImportedData = {}

---Parse the webapp's flat ":"-delimited "Name-Realm:Best:Name-Realm:Best:..."
---string (see LookupForm.tsx's toImportString) into a lookup table. Safe to
---split the whole string on ":" since names/realms never contain one.
---@param text string
---@return table<string, number>
local function ParseImportText(text)
	local data = {}
	local clean = text:gsub("%s", "") -- strip any incidental whitespace/newlines from pasting
	local tokens = {}
	for token in clean:gmatch("[^:]+") do
		table.insert(tokens, token)
	end
	for i = 1, #tokens - 1, 2 do
		local key = tokens[i]
		local value = tonumber(tokens[i + 1])
		if key and value then
			data[key] = value
		end
	end
	return data
end

-- Percentile color tiers, matching the webapp's percentileColor() exactly
-- (same hex values: orange/purple/blue/green/grey).
local function PercentileColorCode(pct)
	if pct >= 95 then
		return "|cffff8000" -- orange
	elseif pct >= 75 then
		return "|cffa335ee" -- purple
	elseif pct >= 50 then
		return "|cff0070dd" -- blue
	elseif pct >= 25 then
		return "|cff1eff00" -- green
	else
		return "|cff9d9d9d" -- grey
	end
end

local function GetImportedBest(name, realm)
	return QueueAnalyzerImportedData[name .. "-" .. realm]
end

local REPO_URL = "https://github.com/LaCocoRoco/queue-analyzer"

-- WoW's UI widgets have no concept of a clickable external link (chat
-- hyperlinks only open in-game item/spell/quest panels, never a browser),
-- so this is just a small label plus a single-line EditBox pre-filled with
-- the URL -- click it to select-all, then Ctrl+C, same copy pattern as the
-- rest of the addon. Purely informational: never fetched or used by the
-- addon itself (no network access in the WoW sandbox anyway).
local function AddRepoFooter(f)
	local label = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	label:SetPoint("BOTTOM", 0, 24)
	label:SetText("Queue Analyzer:")

	local box = CreateFrame("EditBox", nil, f)
	box:SetSize(360, 14)
	box:SetPoint("TOP", label, "BOTTOM", 0, -2)
	box:SetFontObject(GameFontDisableSmall)
	box:SetJustifyH("CENTER")
	box:SetAutoFocus(false)
	box:SetText(REPO_URL)
	box:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	box:SetScript("OnMouseDown", function(self)
		self:SetFocus()
		self:HighlightText()
	end)
end

local frame

local function CreateExportFrame()
	local f = CreateFrame("Frame", "QueueAnalyzerExportFrame", UIParent, "BasicFrameTemplateWithInset")
	f:SetSize(420, 514)
	f:SetPoint("CENTER")
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", f.StopMovingOrSizing)
	f:SetClampedToScreen(true)
	tinsert(UISpecialFrames, "QueueAnalyzerExportFrame") -- Escape closes it

	f.title = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	f.title:SetPoint("LEFT", f.TitleBg, "LEFT", 5, 0)
	f.title:SetText("Queue Analyzer - Applicants")

	f.hint = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.hint:SetPoint("TOPLEFT", 14, -30)
	f.hint:SetPoint("RIGHT", -14, 0)
	f.hint:SetJustifyH("LEFT")
	f.hint:SetText("Ctrl+A, Ctrl+C to copy. Only shows data if you're the group leader with applicants.")

	local scrollFrame = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
	scrollFrame:SetPoint("TOPLEFT", 14, -50)
	scrollFrame:SetPoint("BOTTOMRIGHT", -30, 78)

	local editBox = CreateFrame("EditBox", "QueueAnalyzerExportEditBox", scrollFrame)
	editBox:SetMultiLine(true)
	editBox:SetFontObject(ChatFontNormal)
	editBox:SetWidth(360)
	editBox:SetAutoFocus(false)
	editBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	scrollFrame:SetScrollChild(editBox)
	f.editBox = editBox

	local refreshButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	refreshButton:SetText("Refresh")
	refreshButton:SetSize(120, 24)
	refreshButton:SetPoint("BOTTOM", -65, 44)
	refreshButton:SetScript("OnClick", function() QueueAnalyzer_RefreshExport() end)

	local importButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	importButton:SetText("Open Import")
	importButton:SetSize(120, 24)
	importButton:SetPoint("BOTTOM", 65, 44)
	importButton:SetScript("OnClick", function() QueueAnalyzer_ToggleImportFrame() end)

	AddRepoFooter(f)

	return f
end

function QueueAnalyzer_RefreshExport()
	if not frame then
		return
	end

	local names = GetApplicantNames()
	local text
	if #names == 0 then
		text = "(No applicants found. You must be the group leader of a listing with applicants.)"
	else
		-- One flat ":"-delimited string instead of one name per line -- easier
		-- to select/copy reliably as a single line, and the webapp reads it
		-- back the same way (splits on ":"; names/realms never contain ":").
		text = table.concat(names, ":")
	end

	frame.editBox:SetText(text)
	-- Order matters: SetFocus() must come before HighlightText() -- the
	-- reverse order (as this used to be) leaves the text visually selected
	-- but not reliably in the EditBox's actual input focus, so Ctrl+C does
	-- nothing until the user manually clicks in and re-selects.
	frame.editBox:SetFocus()
	frame.editBox:HighlightText()
end

function QueueAnalyzer_ToggleExportFrame()
	if not frame then
		frame = CreateExportFrame()
	end

	if frame:IsShown() then
		frame:Hide()
		return
	end

	frame:Show()
	QueueAnalyzer_RefreshExport()
end

local importFrame

local function CreateImportFrame()
	local f = CreateFrame("Frame", "QueueAnalyzerImportFrame", UIParent, "BasicFrameTemplateWithInset")
	f:SetSize(420, 514)
	-- Anchored to the right of the export window by default so both can sit
	-- side by side: export on the left (where you copy the applicant list
	-- from), import on the right (where you paste the webapp's result back
	-- in) -- matches the requested "neben dem Fenster, aus dem wir
	-- exportiert haben" placement. Still freely draggable afterwards.
	if frame then
		f:SetPoint("TOPLEFT", frame, "TOPRIGHT", 10, 0)
	else
		f:SetPoint("CENTER", 220, 0)
	end
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", f.StopMovingOrSizing)
	f:SetClampedToScreen(true)
	tinsert(UISpecialFrames, "QueueAnalyzerImportFrame") -- Escape closes it

	f.title = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
	f.title:SetPoint("LEFT", f.TitleBg, "LEFT", 5, 0)
	f.title:SetText("Queue Analyzer - Import")

	f.hint = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.hint:SetPoint("TOPLEFT", 14, -30)
	f.hint:SetPoint("RIGHT", -14, 0)
	f.hint:SetJustifyH("LEFT")
	f.hint:SetText("Paste the text from the webapp here (Ctrl+V) and click Import. The Best value then shows up colored in the applicant tooltip.")

	local scrollFrame = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
	scrollFrame:SetPoint("TOPLEFT", 14, -50)
	scrollFrame:SetPoint("BOTTOMRIGHT", -30, 78)

	local editBox = CreateFrame("EditBox", "QueueAnalyzerImportEditBox", scrollFrame)
	editBox:SetMultiLine(true)
	editBox:SetFontObject(ChatFontNormal)
	editBox:SetWidth(360)
	editBox:SetAutoFocus(false)
	editBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	scrollFrame:SetScrollChild(editBox)
	f.editBox = editBox

	f.status = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.status:SetPoint("BOTTOM", 0, 68)
	f.status:SetText("")

	local importButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	importButton:SetText("Import")
	importButton:SetSize(120, 24)
	importButton:SetPoint("BOTTOM", 0, 44)
	importButton:SetScript("OnClick", function()
		local data = ParseImportText(f.editBox:GetText())
		local count = 0
		for _ in pairs(data) do
			count = count + 1
		end
		QueueAnalyzerImportedData = data
		f.status:SetText(count .. " entries imported.")
	end)

	AddRepoFooter(f)

	return f
end

function QueueAnalyzer_ToggleImportFrame()
	if not importFrame then
		importFrame = CreateImportFrame()
	end

	if importFrame:IsShown() then
		importFrame:Hide()
		return
	end

	importFrame:Show()
	-- Auto-focus (unlike the export box) since the whole point of this box
	-- is to immediately Ctrl+V into it.
	importFrame.editBox:SetFocus()
end

SLASH_QUEUEANALYZER1 = "/qa"
SLASH_QUEUEANALYZER2 = "/queueanalyzer"
SlashCmdList["QUEUEANALYZER"] = QueueAnalyzer_ToggleExportFrame

SLASH_QUEUEANALYZERIMPORT1 = "/qai"
SlashCmdList["QUEUEANALYZERIMPORT"] = QueueAnalyzer_ToggleImportFrame

-- Right-click entry on individual applicants: right-clicking a member row
-- already opens a Blizzard context menu (Whisper/Report), built with the
-- modern Menu API and tagged "MENU_LFG_FRAME_MEMBER_APPLY" (confirmed
-- against Blizzard's own LFGListApplicantMember_OnMouseDown). Menu.ModifyMenu
-- is Blizzard's sanctioned extension point for exactly this -- no click
-- hijacking, no taint risk. Safe to register immediately; it fires
-- whenever that menu is opened, regardless of load order.
if Menu and Menu.ModifyMenu then
	Menu.ModifyMenu("MENU_LFG_FRAME_MEMBER_APPLY", function(owner, rootDescription)
		rootDescription:CreateDivider()
		rootDescription:CreateButton("Copy all applicants (Queue Analyzer)", QueueAnalyzer_ToggleExportFrame)
	end)
end

-- Walk up from an applicant-member row's frame looking for the ancestor that
-- carries .applicantID -- Blizzard stores it on the applicant entry frame,
-- one or two levels above the individual member sub-frame the OnEnter fires
-- on, and the exact depth isn't worth hardcoding when a short walk covers
-- it regardless.
local function FindApplicantID(f)
	local current = f
	for _ = 1, 5 do
		if not current then
			return nil
		end
		if current.applicantID then
			return current.applicantID
		end
		current = current.GetParent and current:GetParent()
	end
	return nil
end

-- Appends the imported "Best" value (colored like the webapp's percentile
-- tiers) to the tooltip Blizzard already shows when hovering a member of an
-- applicant in the Application Viewer -- so you can see it while reviewing
-- applicants instead of alt-tabbing to compare against the webapp table.
-- LFGListApplicantMember_OnEnter is defined inside Blizzard_GroupFinder,
-- which is load-on-demand -- same reason AddApplicationViewerButton below
-- waits for ADDON_LOADED instead of hooking at file-load time.
local hookedApplicantTooltip = false
local function HookApplicantTooltip()
	if hookedApplicantTooltip or not LFGListApplicantMember_OnEnter then
		return
	end
	hookedApplicantTooltip = true

	hooksecurefunc("LFGListApplicantMember_OnEnter", function(self)
		local applicantID = FindApplicantID(self)
		local memberIdx = self.memberIdx
		if not applicantID or not memberIdx then
			return
		end

		local fullName = C_LFGList.GetApplicantMemberInfo(applicantID, memberIdx)
		if not fullName then
			return
		end
		local name, realm = strsplit("-", fullName)
		if not realm or realm == "" then
			realm = GetNormalizedRealmName()
		end

		local best = GetImportedBest(name, realm)
		if best and GameTooltip:IsOwned(self) then
			GameTooltip:AddLine(" ")
			GameTooltip:AddLine("Queue Analyzer Best: " .. PercentileColorCode(best) .. string.format("%.1f", best) .. "|r")
			GameTooltip:Show()
		end
	end)
end

-- Button above the applicant list. LFGListFrame only exists once the
-- Blizzard_GroupFinder addon has loaded (it's load-on-demand), so this
-- waits for that before creating/parenting the button.
local function AddApplicationViewerButton()
	local panel = LFGListFrame.ApplicationViewer
	if not panel or panel.QueueAnalyzerButton then
		return
	end

	local button = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
	button:SetSize(150, 20)
	button:SetText("Copy Applicants")
	button:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -6, -4)
	button:SetScript("OnClick", QueueAnalyzer_ToggleExportFrame)
	panel.QueueAnalyzerButton = button
end

local function OnGroupFinderLoaded()
	AddApplicationViewerButton()
	HookApplicantTooltip()
end

local loader = CreateFrame("Frame")
loader:RegisterEvent("ADDON_LOADED")
loader:SetScript("OnEvent", function(_, _, addonName)
	if addonName == "Blizzard_GroupFinder" then
		OnGroupFinderLoaded()
	end
end)

-- Blizzard_GroupFinder may already be loaded by the time we get here
-- (e.g. after a /reload while the group finder was open).
if C_AddOns and C_AddOns.IsAddOnLoaded and C_AddOns.IsAddOnLoaded("Blizzard_GroupFinder") then
	OnGroupFinderLoaded()
end
