package bilibili

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/mdp/qrterminal/v3"
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

func (c *Client) LoginWithQRCode() error {
	resp, err := c.httpClient.R().Get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
	if err != nil {
		return err
	}

	var genResp QRCodeGenerateResponse
	if err := json.Unmarshal(resp.Body(), &genResp); err != nil {
		return err
	}

	if genResp.Code != 0 {
		return fmt.Errorf("generate qrcode error: %s", genResp.Message)
	}

	fmt.Println("\n--- Bilibili QR Code Login ---")
	fmt.Println("Please scan the QR code below using your Bilibili App:")

	config := qrterminal.Config{
		Level:     qrterminal.L,
		Writer:    os.Stdout,
		BlackChar: qrterminal.BLACK,
		WhiteChar: qrterminal.WHITE,
		QuietZone: 1,
	}
	qrterminal.GenerateWithConfig(genResp.Data.URL, config)

	fmt.Printf("\nIf the QR code doesn't show properly, copy this URL to your browser:\n%s\n", genResp.Data.URL)
	fmt.Println("\nWaiting for scan...")

	for {
		time.Sleep(2 * time.Second)
		pollResp, err := c.httpClient.R().
			SetQueryParam("qrcode_key", genResp.Data.QRCodeKey).
			Get("https://passport.bilibili.com/x/passport-login/web/qrcode/poll")
		if err != nil {
			return err
		}

		var pollData QRCodePollResponse
		if err := json.Unmarshal(pollResp.Body(), &pollData); err != nil {
			return err
		}

		switch pollData.Data.Code {
		case 0:
			fmt.Println("\nLogin success!")
			// Cookies are automatically handled by resty's cookiejar
			return c.SaveCookies()
		case 86101: // Waiting for scan
			continue
		case 86090: // Scanned but not confirmed
			fmt.Println("QR code scanned, please confirm on your phone...")
			continue
		case 86038: // Expired
			return fmt.Errorf("QR code expired, please run the program again")
		default:
			return fmt.Errorf("login failed: %s", pollData.Data.Message)
		}
	}
}
