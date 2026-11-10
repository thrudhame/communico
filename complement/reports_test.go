// Copy into the pinned Complement checkout's tests/csapi for the targeted G1 proof.
package csapi_tests

import (
	"io"
	"testing"

	"github.com/matrix-org/complement"
	"github.com/matrix-org/complement/b"
	"github.com/matrix-org/complement/client"
	"github.com/matrix-org/complement/helpers"
)

func TestCommunicoReporting(t *testing.T) {
	deployment := complement.Deploy(t, 1)
	defer deployment.Destroy(t)
	alice := deployment.Register(t, "hs1", helpers.RegistrationOpts{})
	bob := deployment.Register(t, "hs1", helpers.RegistrationOpts{LocalpartSuffix: "bob"})
	room := alice.MustCreateRoom(t, map[string]interface{}{"preset": "public_chat"})
	event := alice.SendEventSynced(t, room, b.Event{
		Type: "m.room.message", Content: map[string]interface{}{"msgtype": "m.text", "body": "reported"},
	})
	base := []string{"_matrix", "client", "v3"}
	cases := []struct {
		name string
		user *client.CSAPI
		path []string
		body map[string]interface{}
		status int
	}{
		{"event optional fields", alice, []string{"rooms", room, "report", event}, map[string]interface{}{}, 200},
		{"event reason and score", alice, []string{"rooms", room, "report", event}, map[string]interface{}{"reason": "abuse", "score": -100}, 200},
		{"event outsider", bob, []string{"rooms", room, "report", event}, map[string]interface{}{}, 404},
		{"unknown event", alice, []string{"rooms", room, "report", "$unknown"}, map[string]interface{}{}, 404},
		{"room outsider", bob, []string{"rooms", room, "report"}, map[string]interface{}{"reason": ""}, 200},
		{"user without shared room", bob, []string{"users", alice.UserID, "report"}, map[string]interface{}{"reason": "abuse"}, 200},
		{"unknown user no disclosure", bob, []string{"users", "@unknown:hs1", "report"}, map[string]interface{}{"reason": "abuse"}, 200},
		{"room reason required", alice, []string{"rooms", room, "report"}, map[string]interface{}{}, 400},
		{"user reason required", bob, []string{"users", alice.UserID, "report"}, map[string]interface{}{}, 400},
		{"typed score", alice, []string{"rooms", room, "report", event}, map[string]interface{}{"score": "bad"}, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := append(append([]string{}, base...), tc.path...)
			res := tc.user.Do(t, "POST", path, client.WithJSONBody(t, tc.body))
			defer res.Body.Close()
			body, _ := io.ReadAll(res.Body)
			if res.StatusCode != tc.status {
				t.Fatalf("got %d, want %d: %s", res.StatusCode, tc.status, body)
			}
		})
	}
}
