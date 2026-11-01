## Default Permission

Lets the app ask what it is being driven with (a hardware keyboard, the on-screen keypad) and hear when that changes. Lets it pick documents and a folder, make documents in the folder, delete a picked document, fetch the files it was asked to open, open the share sheet, and ask Google Play services for a Drive authorization and give a token back; writing a picked document is done from the Rust side and needs no permission.

#### This default permission set includes the following:

- `allow-state`
- `allow-register-listener`
- `allow-remove-listener`
- `allow-pick-folder`
- `allow-pick-documents`
- `allow-opened-files`
- `allow-delete-document`
- `allow-create-document`
- `allow-mime-for`
- `allow-share`
- `allow-authorize`
- `allow-clear-token`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`device:allow-authorize`

</td>
<td>

Enables the authorize command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-authorize`

</td>
<td>

Denies the authorize command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-clear-token`

</td>
<td>

Enables the clear_token command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-clear-token`

</td>
<td>

Denies the clear_token command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-create-document`

</td>
<td>

Enables the create_document command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-create-document`

</td>
<td>

Denies the create_document command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-delete-document`

</td>
<td>

Enables the delete_document command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-delete-document`

</td>
<td>

Denies the delete_document command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-mime-for`

</td>
<td>

Enables the mime_for command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-mime-for`

</td>
<td>

Denies the mime_for command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-opened-files`

</td>
<td>

Enables the opened_files command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-opened-files`

</td>
<td>

Denies the opened_files command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-pick-documents`

</td>
<td>

Enables the pick_documents command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-pick-documents`

</td>
<td>

Denies the pick_documents command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-pick-folder`

</td>
<td>

Enables the pick_folder command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-pick-folder`

</td>
<td>

Denies the pick_folder command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-register-listener`

</td>
<td>

Enables the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-register-listener`

</td>
<td>

Denies the register_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-remove-listener`

</td>
<td>

Enables the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-remove-listener`

</td>
<td>

Denies the remove_listener command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-share`

</td>
<td>

Enables the share command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-share`

</td>
<td>

Denies the share command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:allow-state`

</td>
<td>

Enables the state command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`device:deny-state`

</td>
<td>

Denies the state command without any pre-configured scope.

</td>
</tr>
</table>
