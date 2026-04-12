package bilibili

import (
	"encoding/json"
	"fmt"
)

type QRCodeGenerateResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		URL       string `json:"url"`
		QRCodeKey string `json:"qrcode_key"`
	} `json:"data"`
}

type QRCodePollResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		URL          string `json:"url"`
		RefreshToken string `json:"refresh_token"`
		Timestamp    int64  `json:"timestamp"`
		Code         int    `json:"code"`
		Message      string `json:"message"`
	} `json:"data"`
}

func (c *Client) GenerateQR() (string, string, error) {
	resp, err := c.httpClient.R().Get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
	if err != nil {
		return "", "", err
	}

	var genResp QRCodeGenerateResponse
	if err := json.Unmarshal(resp.Body(), &genResp); err != nil {
		return "", "", err
	}

	if genResp.Code != 0 {
		return "", "", fmt.Errorf("generate qrcode error: %s", genResp.Message)
	}

	return genResp.Data.URL, genResp.Data.QRCodeKey, nil
}

func (c *Client) PollQR(qrcodeKey string) (int, error) {
	pollResp, err := c.httpClient.R().
		SetQueryParam("qrcode_key", qrcodeKey).
		Get("https://passport.bilibili.com/x/passport-login/web/qrcode/poll")
	if err != nil {
		return -1, err
	}

	var pollData QRCodePollResponse
	if err := json.Unmarshal(pollResp.Body(), &pollData); err != nil {
		return -1, err
	}

	if pollData.Data.Code == 0 {
		// Login success, automatically handled by resty's cookiejar
		err := c.SaveCookies()
		return 0, err
	}

	return pollData.Data.Code, nil
}
