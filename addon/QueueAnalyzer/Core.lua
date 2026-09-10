-- Core.lua
-- Reads every current applicant to your posted Group Finder listing (you
-- must be the group leader with an active listing that has applicants --
-- this is the Premade Groups applicant queue, not the anonymous automatic
-- Dungeon Finder matchmaking queue, which never exposes names at all).
--
-- C_LFGList.GetApplicants() returns every applicant ID for your listing in
-- one call (confirmed against Blizzard's own LFGListApplicationViewer
-- update code) -- no need to hover or scroll through the UI.

BINDING_HEADER_QUEUEANALYZER = "Queue Analyzer"
BINDING_NAME_QUEUEANALYZER_TOGGLE = "Bewerber-Namen anzeigen/exportieren"

---Collect "Name-Realm" for every member of every current applicant.
---@return string[] names
local function GetApplicantNames()
	local names = {}

	local applicants = C_LFGList.GetApplicants()
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

local frame

local function CreateExportFrame()
	local f = CreateFrame("Frame", "QueueAnalyzerExportFrame", UIParent, "BasicFrameTemplateWithInset")
	f:SetSize(420, 480)
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
	f.title:SetText("Queue Analyzer - Bewerber")

	f.hint = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	f.hint:SetPoint("TOPLEFT", 14, -30)
	f.hint:SetPoint("RIGHT", -14, 0)
	f.hint:SetJustifyH("LEFT")
	f.hint:SetText("Strg+A, Strg+C zum Kopieren. Nur sichtbar, wenn du Gruppenleiter mit Bewerbern bist.")

	local scrollFrame = CreateFrame("ScrollFrame", nil, f, "UIPanelScrollFrameTemplate")
	scrollFrame:SetPoint("TOPLEFT", 14, -50)
	scrollFrame:SetPoint("BOTTOMRIGHT", -30, 44)

	local editBox = CreateFrame("EditBox", "QueueAnalyzerExportEditBox", scrollFrame)
	editBox:SetMultiLine(true)
	editBox:SetFontObject(ChatFontNormal)
	editBox:SetWidth(360)
	editBox:SetAutoFocus(false)
	editBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
	scrollFrame:SetScrollChild(editBox)
	f.editBox = editBox

	local refreshButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
	refreshButton:SetText("Aktualisieren")
	refreshButton:SetSize(120, 24)
	refreshButton:SetPoint("BOTTOM", 0, 10)
	refreshButton:SetScript("OnClick", function() QueueAnalyzer_RefreshExport() end)

	return f
end

function QueueAnalyzer_RefreshExport()
	if not frame then
		return
	end

	local names = GetApplicantNames()
	local text
	if #names == 0 then
		text = "(Keine Bewerber gefunden. Du musst Gruppenleiter einer Anzeige mit Bewerbern sein.)"
	else
		text = table.concat(names, "\n")
	end

	frame.editBox:SetText(text)
	frame.editBox:HighlightText()
	frame.editBox:SetFocus()
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

SLASH_QUEUEANALYZER1 = "/qa"
SLASH_QUEUEANALYZER2 = "/queueanalyzer"
SlashCmdList["QUEUEANALYZER"] = QueueAnalyzer_ToggleExportFrame
