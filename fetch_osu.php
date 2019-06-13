<?php

if($_SERVER["REQUEST_METHOD"] == "GET") {
    // fetch .osu file from osu.ppy.sh
    if(isset($_GET["id"])) {
        $id = $_GET["id"];
        header('Content-Type:text/plain'); // output plain text
        echo file_get_contents("https://osu.ppy.sh/osu/$id");
    }
}

?>
