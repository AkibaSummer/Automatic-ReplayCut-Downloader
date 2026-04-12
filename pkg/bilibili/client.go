package bilibili

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/AkibaSummer/Automatic-ReplayCut-Downloader/internal/model"
	"github.com/go-resty/resty/v2"
)

type Client struct {
	httpClient *resty.Client
	liveUID    int
	cookieFile string
}

func NewClient(liveUID int, cookies map[string]string, cookieFile string) *Client {
	jar, _ := cookiejar.New(nil)
	client := resty.New()
	client.SetCookieJar(jar)
	client.SetBaseURL("https://api.live.bilibili.com")
	client.SetTimeout(20 * time.Second)

	client.SetHeaders(map[string]string{
		"accept":          "*/*",
		"accept-language": "en-US,en;q=0.9,zh-CN;q=0.8,zh-TW;q=0.7,zh;q=0.6,ja-JP;q=0.5,ja;q=0.4",
		"origin":          "https://live.bilibili.com",
		"referer":         "https://live.bilibili.com/",
		"user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
	})

	// Load from file first
	if cookieFile != "" {
		if data, err := os.ReadFile(cookieFile); err == nil {
			var savedCookies map[string]string
			if err := json.Unmarshal(data, &savedCookies); err == nil {
				u, _ := url.Parse("https://bilibili.com")
				var cookieList []*http.Cookie
				for k, v := range savedCookies {
					cookieList = append(cookieList, &http.Cookie{Name: k, Value: v})
				}
				jar.SetCookies(u, cookieList)

				u2, _ := url.Parse("https://api.bilibili.com")
				jar.SetCookies(u2, cookieList)

				u3, _ := url.Parse("https://api.live.bilibili.com")
				jar.SetCookies(u3, cookieList)
			}
		}
	}

	// Override with provided cookies
	for k, v := range cookies {
		client.SetCookie(&http.Cookie{Name: k, Value: v})
	}

	return &Client{
		httpClient: client,
		liveUID:    liveUID,
		cookieFile: cookieFile,
	}
}

func (c *Client) SaveCookies() error {
	if c.cookieFile == "" {
		return nil
	}
	u, _ := url.Parse("https://api.live.bilibili.com")
	cookies := c.httpClient.GetClient().Jar.Cookies(u)

	cookieMap := make(map[string]string)
	for _, cookie := range cookies {
		cookieMap[cookie.Name] = cookie.Value
	}

	data, err := json.MarshalIndent(cookieMap, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(c.cookieFile, data, 0644)
}

func (c *Client) IsLoggedIn() bool {
	resp, err := c.httpClient.R().Get("https://api.bilibili.com/x/web-interface/nav")
	if err != nil {
		return false
	}
	var res struct {
		Code int `json:"code"`
	}
	if err := json.Unmarshal(resp.Body(), &res); err != nil {
		return false
	}
	return res.Code == 0
}

type CurrentUser struct {
	Uname string
	Face  string
}

func (c *Client) GetCurrentUser() (CurrentUser, error) {
	resp, err := c.httpClient.R().Get("https://api.bilibili.com/x/web-interface/nav")
	if err != nil {
		return CurrentUser{}, err
	}
	var res struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Uname string `json:"uname"`
			Face  string `json:"face"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp.Body(), &res); err != nil {
		return CurrentUser{}, err
	}
	if res.Code != 0 {
		return CurrentUser{}, fmt.Errorf("bilibili api error: %s", res.Message)
	}
	return CurrentUser{Uname: res.Data.Uname, Face: res.Data.Face}, nil
}

type SliceListResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		ReplayInfo []struct {
			ReplayID int    `json:"replay_id"`
			RoomID   int    `json:"room_id"`
			LiveKey  string `json:"live_key"`
			LiveInfo struct {
				Title    string `json:"title"`
				Cover    string `json:"cover"`
				LiveTime int64  `json:"live_time"`
			} `json:"live_info"`
			VideoInfo struct {
				Duration int `json:"duration"`
			} `json:"video_info"`
			StartTime int64 `json:"start_time"`
			EndTime   int64 `json:"end_time"`
		} `json:"replay_info"`
	} `json:"data"`
}

func (c *Client) GetReplayList(timeRange int, page int, pageSize int) ([]model.BilibiliReplay, error) {
	resp, err := c.httpClient.R().
		SetQueryParams(map[string]string{
			"live_uid":     strconv.Itoa(c.liveUID),
			"time_range":   strconv.Itoa(timeRange),
			"page":         strconv.Itoa(page),
			"page_size":    strconv.Itoa(pageSize),
			"web_location": "444.194",
		}).
		Get("/xlive/web-room/v1/videoService/GetOtherSliceList")

	if err != nil {
		return nil, err
	}

	var sliceListResp SliceListResponse
	if err := json.Unmarshal(resp.Body(), &sliceListResp); err != nil {
		return nil, err
	}

	if sliceListResp.Code != 0 {
		return nil, fmt.Errorf("bilibili api error: %s", sliceListResp.Message)
	}

	var replays []model.BilibiliReplay
	for _, info := range sliceListResp.Data.ReplayInfo {
		replays = append(replays, model.BilibiliReplay{
			ReplayID:  info.ReplayID,
			LiveKey:   info.LiveKey,
			RoomID:    info.RoomID,
			Title:     info.LiveInfo.Title,
			CoverURL:  info.LiveInfo.Cover,
			StartTime: info.StartTime,
			EndTime:   info.EndTime,
			Duration:  info.VideoInfo.Duration,
		})
	}

	return replays, nil
}

type StreamResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		List []model.StreamSlice `json:"list"`
	} `json:"data"`
}

func (c *Client) GetReplayStreams(liveKey string, startTime int64, endTime int64) ([]model.StreamSlice, error) {
	resp, err := c.httpClient.R().
		SetQueryParams(map[string]string{
			"live_key":     liveKey,
			"start_time":   strconv.FormatInt(startTime, 10),
			"end_time":     strconv.FormatInt(endTime, 10),
			"live_uid":     strconv.Itoa(c.liveUID),
			"web_location": "444.194",
		}).
		Get("/xlive/web-room/v1/videoService/GetUserSliceStream")

	if err != nil {
		return nil, err
	}

	var streamResp StreamResponse
	if err := json.Unmarshal(resp.Body(), &streamResp); err != nil {
		return nil, err
	}

	if streamResp.Code != 0 {
		return nil, fmt.Errorf("bilibili api error: %s", streamResp.Message)
	}

	return streamResp.Data.List, nil
}
